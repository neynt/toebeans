// telnyx-voice plugin for toebeans
// enables real-time phone conversations with the AI via telnyx voice api
//
// architecture:
//   1. HTTP webhook server receives telnyx call events (call.initiated, etc.)
//   2. answers incoming calls with stream_url pointing to our websocket server
//   3. websocket server receives/sends audio as base64 JSON (telnyx media streaming)
//   4. pipeline: audio in → VAD → whisper transcription → LLM → TTS → audio out
//
// telnyx websocket protocol:
//   incoming: { event: 'start', start: { call_control_id, media_format: { encoding, sample_rate, channels } }, stream_id }
//   incoming: { event: 'media', media: { payload: '<base64 audio>' }, stream_id }
//   incoming: { event: 'stop', stream_id }
//   outgoing: { event: 'media', media: { payload: '<base64 audio>' } }

import type { ServerWebSocket } from 'bun'
import { spawn, type ChildProcess } from 'node:child_process'
import * as http from 'node:http'
import { homedir } from 'os'
import { join } from 'path'

interface TelnyxVoiceConfig {
  apiKey: string                    // telnyx API key (v2)
  connectionId?: string             // telnyx connection ID (SIP/credential) for outbound calls
  phoneNumber?: string              // telnyx phone number (for outbound calls)
  webhookPort?: number              // port for telnyx webhooks (default: 8089)
  mediaWsPort?: number              // port for media websocket (default: 8090)
  publicHost?: string               // public hostname/IP for telnyx to reach us
  streamBidirectionalCodec?: string // L16, PCMU, OPUS, etc. (default: L16)
  sampleRate?: number               // 8000 or 16000 (default: 8000)
  // VAD settings
  silenceThresholdMs?: number       // silence duration before triggering transcription (default: 700)
  silenceEnergyThreshold?: number   // RMS energy below this = silence (default: 200)
  // TTS settings
  ttsSocketPath?: string            // unix socket for qwen3-tts server
  voiceInstruct?: string            // voice description for TTS
}

// telnyx websocket message types
interface TelnyxMediaStart {
  event: 'start'
  sequence_number: string
  start: {
    user_id: string
    call_control_id: string
    client_state: string
    media_format: {
      encoding: string
      sample_rate: number
      channels: number
    }
  }
  stream_id: string
}

interface TelnyxMediaPayload {
  event: 'media'
  sequence_number: string
  media: {
    track: string
    chunk: string
    timestamp: string
    payload: string // base64-encoded audio
  }
  stream_id: string
}

interface TelnyxMediaStop {
  event: 'stop'
  sequence_number: string
  stream_id: string
}

type TelnyxWsMessage =
  | { event: 'connected'; version: string }
  | TelnyxMediaStart
  | TelnyxMediaPayload
  | TelnyxMediaStop

// telnyx webhook event types (subset we care about)
interface TelnyxWebhookEvent {
  data: {
    event_type: string
    id: string
    payload: {
      call_control_id: string
      call_leg_id: string
      call_session_id: string
      connection_id: string
      from: string
      to: string
      direction: string
      state: string
      client_state?: string
      stream_url?: string
      [key: string]: unknown
    }
  }
}

// active call state
interface ActiveCall {
  callControlId: string
  streamId: string | null
  from: string
  to: string
  ws: ServerWebSocket<WsData> | null
  mediaFormat: { encoding: string; sampleRate: number; channels: number } | null

  // audio buffer for VAD
  audioChunks: Buffer[]
  audioStartTime: number | null
  lastAudioTime: number
  silenceStart: number | null

  // transcription pipeline state
  isProcessing: boolean // true while running transcription → LLM → TTS
  pendingAudio: Buffer[] // audio that arrived while processing

  // abort control
  abortController: AbortController | null

  // text buffer for streaming TTS output
  textBuffer: string
}

interface WsData {
  callControlId: string | null
}

// message queue for channel plugin input
interface QueuedInput {
  message: { role: 'user'; content: Array<{ type: 'text'; text: string }> }
  outputTarget: string
}

export default function create(serverContext?: any) {
  let config: TelnyxVoiceConfig | null = null
  const activeCalls = new Map<string, ActiveCall>() // callControlId → ActiveCall
  const streamToCall = new Map<string, string>()     // streamId → callControlId

  // message queue for channel plugin input (transcribed speech → agent)
  const messageQueue: QueuedInput[] = []
  let resolveWaiter: (() => void) | null = null

  function queueMessage(text: string, callControlId: string) {
    messageQueue.push({
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
      outputTarget: `telnyx-voice:${callControlId}`,
    })
    if (resolveWaiter) {
      resolveWaiter()
      resolveWaiter = null
    }
  }

  // --- telnyx REST API helpers ---

  async function telnyxApi(method: string, path: string, body?: unknown): Promise<Response> {
    const url = `https://api.telnyx.com/v2${path}`
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${config!.apiKey}`,
      'Content-Type': 'application/json',
    }
    return fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  async function answerCall(callControlId: string) {
    const codec = config!.streamBidirectionalCodec || 'L16'
    const wsPort = config!.mediaWsPort || 8090
    const host = config!.publicHost
    if (!host) {
      console.error('telnyx-voice: publicHost not configured, cannot answer call')
      return
    }

    const streamUrl = `wss://${host}/media`
    console.log(`telnyx-voice: answering call ${callControlId} with stream_url=${streamUrl}`)

    const res = await telnyxApi('POST', `/calls/${callControlId}/actions/answer`, {
      stream_url: streamUrl,
      stream_track: 'inbound_track',
      stream_bidirectional_mode: 'rtp',
      stream_bidirectional_codec: codec,
      // client_state can be used to pass metadata through
      client_state: Buffer.from(JSON.stringify({ plugin: 'telnyx-voice' })).toString('base64'),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`telnyx-voice: failed to answer call: ${res.status} ${err}`)
    }
  }

  async function hangupCall(callControlId: string) {
    try {
      await telnyxApi('POST', `/calls/${callControlId}/actions/hangup`, {})
    } catch (err) {
      console.error(`telnyx-voice: hangup failed:`, err)
    }
  }

  async function createOutboundCall(to: string): Promise<string> {
    if (!config!.connectionId) {
      throw new Error('connectionId not configured — required for outbound calls')
    }
    if (!config!.phoneNumber) {
      throw new Error('phoneNumber not configured — required as caller ID for outbound calls')
    }
    if (!config!.publicHost) {
      throw new Error('publicHost not configured — required for media streaming')
    }

    const codec = config!.streamBidirectionalCodec || 'L16'
    const streamUrl = `wss://${config!.publicHost}/media`

    const res = await telnyxApi('POST', '/calls', {
      connection_id: config!.connectionId,
      to,
      from: config!.phoneNumber,
      stream_url: streamUrl,
      stream_track: 'inbound_track',
      stream_bidirectional_mode: 'rtp',
      stream_bidirectional_codec: codec,
    })

    if (!res.ok) {
      const err = await res.text()
      throw new Error(`telnyx API error ${res.status}: ${err}`)
    }

    const body = await res.json() as { data: { call_control_id: string; call_leg_id: string; call_session_id: string } }
    const callControlId = body.data.call_control_id
    console.log(`telnyx-voice: outbound call created to ${to}, call_control_id=${callControlId}`)

    // pre-register in activeCalls so webhook events find it
    activeCalls.set(callControlId, {
      callControlId,
      streamId: null,
      from: config!.phoneNumber!,
      to,
      ws: null,
      mediaFormat: null,
      audioChunks: [],
      audioStartTime: null,
      lastAudioTime: 0,
      silenceStart: null,
      isProcessing: false,
      pendingAudio: [],
      abortController: null,
      textBuffer: '',
    })

    return callControlId
  }

  // --- voice activity detection ---

  let vadDebugCounter = 0

  function detectSilence(call: ActiveCall, audioBuffer: Buffer): boolean {
    // compute RMS energy of the audio chunk
    const threshold = config!.silenceEnergyThreshold || 200
    let sumSquares = 0
    const sampleRate = call.mediaFormat?.sampleRate || 8000
    const encoding = call.mediaFormat?.encoding || 'L16'

    if (encoding === 'L16' || encoding === 'PCMU' || encoding === 'PCMA') {
      // L16: 16-bit signed PCM, little-endian as sent by Telnyx
      // PCMU/PCMA: single byte per sample (we approximate)
      const bytesPerSample = encoding === 'L16' ? 2 : 1
      const samples = audioBuffer.length / bytesPerSample

      for (let i = 0; i < audioBuffer.length; i += bytesPerSample) {
        let sample: number
        if (encoding === 'L16') {
          sample = audioBuffer.readInt16LE(i)
        } else {
          // mu-law / a-law: approximate by expanding to 16-bit range
          sample = (audioBuffer[i]! - 128) * 256
        }
        sumSquares += sample * sample
      }

      const rms = Math.sqrt(sumSquares / samples)
      const isSilent = rms < threshold

      // log every 50th chunk to avoid spam but still show what's happening
      vadDebugCounter++
      if (vadDebugCounter % 50 === 1) {
        console.log(`telnyx-voice: VAD chunk=${vadDebugCounter} rms=${rms.toFixed(0)} threshold=${threshold} silent=${isSilent} buffered=${call.audioChunks.length} bytes=${audioBuffer.length}`)
      }

      return isSilent
    }

    // for other codecs, assume not silent (conservative)
    return false
  }

  // --- audio pipeline ---

  async function processAudioPipeline(call: ActiveCall) {
    if (call.isProcessing) return
    if (call.audioChunks.length === 0) return

    call.isProcessing = true
    const chunks = call.audioChunks.splice(0)
    const audioBuffer = Buffer.concat(chunks)

    const callId = call.callControlId
    console.log(`telnyx-voice: processing ${audioBuffer.length} bytes of audio from ${call.from}`)

    try {
      // step 1: transcribe audio with whisper
      const transcription = await transcribeAudio(audioBuffer, call)
      if (!transcription || transcription.trim().length === 0) {
        console.log('telnyx-voice: empty transcription, skipping')
        call.isProcessing = false
        return
      }

      console.log(`telnyx-voice: transcription: "${transcription}"`)

      // step 2: queue transcription to agent via channel plugin input
      // the agent response will come back through the output() function
      queueMessage(`[phone call from ${call.from}]: ${transcription}`, callId)
    } catch (err) {
      console.error('telnyx-voice: pipeline error:', err)
    } finally {
      call.isProcessing = false

      // process any audio that arrived while we were busy
      if (call.pendingAudio.length > 0) {
        call.audioChunks.push(...call.pendingAudio.splice(0))
      }
    }
  }

  // --- whisper transcription ---

  async function transcribeAudio(audioBuffer: Buffer, call: ActiveCall): Promise<string> {
    // skip chunks shorter than 0.5s — too short for useful transcription
    // at 8kHz 16-bit mono: 0.5s = 8000 bytes; at 16kHz: 16000 bytes
    const sampleRate = call.mediaFormat?.sampleRate || 8000
    const encoding = call.mediaFormat?.encoding || 'L16'
    const bytesPerSample = (encoding === 'L16') ? 2 : 1
    const minDurationSec = 0.5
    const minBytes = sampleRate * bytesPerSample * minDurationSec
    if (audioBuffer.length < minBytes) {
      console.log(`telnyx-voice: audio too short (${audioBuffer.length} bytes < ${minBytes}), skipping`)
      return ''
    }

    // log audio diagnostics
    const durationSec = audioBuffer.length / (sampleRate * bytesPerSample)
    let rms = 0
    if (encoding === 'L16') {
      let sumSq = 0
      for (let i = 0; i < audioBuffer.length - 1; i += 2) {
        const sample = audioBuffer.readInt16LE(i)
        sumSq += sample * sample
      }
      rms = Math.sqrt(sumSq / (audioBuffer.length / 2))
    }
    console.log(`telnyx-voice: audio stats: ${audioBuffer.length} bytes, ${durationSec.toFixed(2)}s, encoding=${encoding}, rate=${sampleRate}Hz, rms=${rms.toFixed(0)}`)

    try {
      await ensureWhisperServer()

      // build WAV in memory and POST to whisper server
      const wavBuffer = createWavBuffer(audioBuffer, sampleRate, encoding)

      const { status, data } = await unixRequest(
        WHISPER_SOCKET_PATH,
        'POST',
        '/transcribe',
        wavBuffer,
        'audio/wav',
      )

      if (status !== 200) {
        console.error(`telnyx-voice: whisper server error: ${status} ${data.toString()}`)
        return ''
      }

      const result = JSON.parse(data.toString()) as { text: string; language: string; duration: number }
      const transcription = result.text.trim()

      if (!transcription) {
        console.log('telnyx-voice: empty transcription from whisper server')
      } else {
        console.log(`telnyx-voice: whisper result: "${transcription}"`)
      }

      return transcription
    } catch (err) {
      console.error('telnyx-voice: transcription failed:', err)
      return ''
    }
  }

  // create a WAV file buffer from raw PCM data
  function createWavBuffer(pcmData: Buffer, sampleRate: number, encoding: string): Buffer {
    const bitsPerSample = 16
    const numChannels = 1

    // convert incoming audio to little-endian 16-bit PCM for WAV
    let pcm16: Buffer
    if (encoding === 'PCMU') {
      pcm16 = decodeMuLaw(pcmData)
    } else if (encoding === 'PCMA') {
      pcm16 = decodeALaw(pcmData)
    } else {
      // L16 from Telnyx is already little-endian; use as-is for WAV
      pcm16 = pcmData
    }

    // log samples after decoding
    if (pcm16.length >= 4) {
      const s0 = pcm16.readInt16LE(0), s1 = pcm16.readInt16LE(2)
      console.log(`telnyx-voice: createWav decoded first samples: [${s0}, ${s1}] encoding=${encoding}`)
    }

    // upsample to 16kHz for whisper — pyannote VAD fails to detect speech
    // in 8kHz telephony audio (trained on wideband), but works at 16kHz
    const wavSampleRate = sampleRate < 16000 ? 16000 : sampleRate
    if (wavSampleRate !== sampleRate) {
      pcm16 = resamplePcm(pcm16, sampleRate, wavSampleRate)
    }

    const byteRate = wavSampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)
    const dataSize = pcm16.length
    const headerSize = 44
    const wav = Buffer.alloc(headerSize + dataSize)

    // RIFF header
    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + dataSize, 4)
    wav.write('WAVE', 8)

    // fmt chunk
    wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16)           // chunk size
    wav.writeUInt16LE(1, 20)            // PCM format
    wav.writeUInt16LE(numChannels, 22)
    wav.writeUInt32LE(wavSampleRate, 24)
    wav.writeUInt32LE(byteRate, 28)
    wav.writeUInt16LE(blockAlign, 32)
    wav.writeUInt16LE(bitsPerSample, 34)

    // data chunk
    wav.write('data', 36)
    wav.writeUInt32LE(dataSize, 40)
    pcm16.copy(wav, 44)

    return wav
  }

  // mu-law decoding table (ITU-T G.711)
  function decodeMuLaw(data: Buffer): Buffer {
    const MULAW_BIAS = 33
    const out = Buffer.alloc(data.length * 2)
    for (let i = 0; i < data.length; i++) {
      let mulaw = ~data[i]! & 0xff
      const sign = mulaw & 0x80
      const exponent = (mulaw >> 4) & 0x07
      let mantissa = mulaw & 0x0f
      mantissa = ((mantissa << 1) + 1 + MULAW_BIAS) << (exponent + 2)
      mantissa -= MULAW_BIAS
      const sample = sign ? -mantissa : mantissa
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
    }
    return out
  }

  // a-law decoding table (ITU-T G.711)
  function decodeALaw(data: Buffer): Buffer {
    const out = Buffer.alloc(data.length * 2)
    for (let i = 0; i < data.length; i++) {
      let alaw = data[i]! ^ 0x55
      const sign = alaw & 0x80
      alaw &= 0x7f
      const exponent = (alaw >> 4) & 0x07
      let mantissa = alaw & 0x0f
      let sample: number
      if (exponent === 0) {
        sample = (mantissa * 2 + 1) << 3
      } else {
        sample = ((mantissa * 2 + 1 + 32) << (exponent + 2))
      }
      if (sign) sample = -sample
      out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
    }
    return out
  }

  // --- whisper server management ---

  const TOEBEANS_DIR = join(homedir(), '.toebeans')
  const WHISPER_SOCKET_PATH = join(TOEBEANS_DIR, 'whisper.sock')
  const WHISPER_PIDFILE_PATH = join(TOEBEANS_DIR, 'whisper.pid')
  const WHISPER_SERVER_SCRIPT = join(import.meta.dir, 'whisper-server.py')
  let whisperServerProcess: ChildProcess | null = null
  let whisperServerReady = false

  async function isWhisperServerReady(): Promise<boolean> {
    try {
      const { status } = await unixRequest(WHISPER_SOCKET_PATH, 'GET', '/health')
      return status === 200
    } catch {
      return false
    }
  }

  async function ensureWhisperServer(): Promise<void> {
    if (whisperServerReady && await isWhisperServerReady()) return

    // check if an existing server is alive
    try {
      const pidContent = await Bun.file(WHISPER_PIDFILE_PATH).text()
      const pid = parseInt(pidContent.trim(), 10)
      if (!Number.isNaN(pid) && isProcessAlive(pid)) {
        if (await isWhisperServerReady()) {
          whisperServerReady = true
          return
        }
      }
    } catch {}

    // clean up stale files and spawn fresh
    const { unlink: unlinkFile } = await import('node:fs/promises')
    for (const path of [WHISPER_SOCKET_PATH, WHISPER_PIDFILE_PATH]) {
      try { await unlinkFile(path) } catch {}
    }

    console.log('telnyx-voice: spawning whisper server...')
    whisperServerProcess = spawn('python3', [
      WHISPER_SERVER_SCRIPT,
      '--socket', WHISPER_SOCKET_PATH,
      '--pidfile', WHISPER_PIDFILE_PATH,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
    whisperServerProcess.unref()

    whisperServerProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`telnyx-voice/whisper-server: ${data.toString().trim()}`)
    })
    whisperServerProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`telnyx-voice/whisper-server: ${data.toString().trim()}`)
    })
    whisperServerProcess.on('exit', (code: number | null) => {
      console.log(`telnyx-voice/whisper-server exited with code ${code}`)
      whisperServerReady = false
      whisperServerProcess = null
    })

    // wait for server to respond (model loading can take a while)
    const timeout = 120_000
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await isWhisperServerReady()) {
        whisperServerReady = true
        console.log('telnyx-voice: whisper server is ready!')
        return
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    throw new Error('telnyx-voice: whisper server did not start within 120s')
  }

  // --- TTS server management ---

  const TTS_SOCKET_PATH = join(TOEBEANS_DIR, 'tts.sock')
  const TTS_PIDFILE_PATH = join(TOEBEANS_DIR, 'tts.pid')
  const TTS_PLUGIN_DIR = join(TOEBEANS_DIR, 'plugins', 'tts')
  let ttsServerProcess: ChildProcess | null = null
  let ttsServerReady = false

  function unixRequest(
    socketPath: string,
    method: string,
    path: string,
    body?: string | Buffer,
    contentType?: string,
  ): Promise<{ status: number; data: Buffer }> {
    return new Promise((resolve, reject) => {
      const headers: Record<string, string | number> = {}
      if (body) {
        headers['Content-Type'] = contentType || 'application/json'
        headers['Content-Length'] = typeof body === 'string' ? Buffer.byteLength(body) : body.length
      }
      const options: http.RequestOptions = {
        socketPath,
        method,
        path,
        headers: body ? headers : undefined,
      }
      const req = http.request(options, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks) }))
      })
      req.on('error', reject)
      if (body) req.write(body)
      req.end()
    })
  }

  async function isTtsServerReady(): Promise<boolean> {
    try {
      const { status } = await unixRequest(TTS_SOCKET_PATH, 'GET', '/health')
      return status === 200
    } catch {
      return false
    }
  }

  function isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  async function ensureTtsServer(): Promise<void> {
    if (ttsServerReady && await isTtsServerReady()) return

    // check if an existing server is alive (may have been started by the tts plugin)
    try {
      const pidContent = await Bun.file(TTS_PIDFILE_PATH).text()
      const pid = parseInt(pidContent.trim(), 10)
      if (!Number.isNaN(pid) && isProcessAlive(pid)) {
        if (await isTtsServerReady()) {
          ttsServerReady = true
          return
        }
      }
    } catch {}

    // clean up stale files and spawn fresh
    const { unlink } = await import('node:fs/promises')
    for (const path of [TTS_SOCKET_PATH, TTS_PIDFILE_PATH]) {
      try { await unlink(path) } catch {}
    }

    console.log('telnyx-voice: spawning TTS server...')
    const startScript = join(TTS_PLUGIN_DIR, 'start.sh')

    const env: Record<string, string> = { ...process.env as Record<string, string> }
    if (config?.voiceInstruct) {
      env.VOICE_INSTRUCT = config.voiceInstruct
    }

    ttsServerProcess = spawn(startScript, ['--socket', TTS_SOCKET_PATH, '--pidfile', TTS_PIDFILE_PATH], {
      cwd: TTS_PLUGIN_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      env,
    })
    ttsServerProcess.unref()

    ttsServerProcess.stdout?.on('data', (data: Buffer) => {
      console.log(`telnyx-voice/tts-server: ${data.toString().trim()}`)
    })
    ttsServerProcess.stderr?.on('data', (data: Buffer) => {
      console.error(`telnyx-voice/tts-server: ${data.toString().trim()}`)
    })
    ttsServerProcess.on('exit', (code: number | null) => {
      console.log(`telnyx-voice/tts-server exited with code ${code}`)
      ttsServerReady = false
      ttsServerProcess = null
    })

    // wait for server to respond
    const timeout = 120_000
    const start = Date.now()
    while (Date.now() - start < timeout) {
      if (await isTtsServerReady()) {
        ttsServerReady = true
        console.log('telnyx-voice: TTS server is ready!')
        return
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
    }

    throw new Error('telnyx-voice: TTS server did not start within 120s')
  }

  // --- TTS output: generate speech and send back through telnyx websocket ---

  async function sendTtsToCall(text: string, call: ActiveCall) {
    if (!call.ws) {
      console.warn('telnyx-voice: no websocket for call, cannot send TTS')
      return
    }

    try {
      const socketPath = config!.ttsSocketPath || TTS_SOCKET_PATH
      await ensureTtsServer()

      const requestBody: { text: string; language: string; instruct?: string } = {
        text,
        language: 'english',
      }
      if (config!.voiceInstruct) {
        requestBody.instruct = config!.voiceInstruct
      }

      const ttsResponse = await unixRequest(socketPath, 'POST', '/tts', JSON.stringify(requestBody))

      if (ttsResponse.status !== 200) {
        console.error(`telnyx-voice: TTS error: ${ttsResponse.status}`)
        return
      }

      // ttsResponse.data is a WAV file
      // we need to extract PCM data, resample to the call's sample rate,
      // and send as base64 chunks through the websocket
      const wavData = ttsResponse.data
      const pcmData = extractPcmFromWav(wavData)

      if (!pcmData) {
        console.error('telnyx-voice: failed to extract PCM from TTS WAV')
        return
      }

      // resample from TTS sample rate (typically 24000) to call sample rate
      const callSampleRate = call.mediaFormat?.sampleRate || 8000
      const resampled = resamplePcm(pcmData.samples, pcmData.sampleRate, callSampleRate)

      // encode to the call's codec
      const callEncoding = call.mediaFormat?.encoding || 'L16'
      let encodedAudio: Buffer
      if (callEncoding === 'PCMU') {
        encodedAudio = encodeMuLaw(resampled)
      } else if (callEncoding === 'PCMA') {
        encodedAudio = encodeALaw(resampled)
      } else {
        // L16: Telnyx accepts little-endian; resampler already outputs LE
        encodedAudio = resampled
      }

      // send in chunks (20ms frames)
      const bytesPerSample = callEncoding === 'L16' ? 2 : 1
      const frameMs = 20
      const frameSamples = callSampleRate * frameMs / 1000
      const frameBytes = frameSamples * bytesPerSample

      for (let offset = 0; offset < encodedAudio.length; offset += frameBytes) {
        const chunk = encodedAudio.subarray(offset, offset + frameBytes)
        const payload = chunk.toString('base64')

        try {
          call.ws.send(JSON.stringify({
            event: 'media',
            media: { payload },
          }))
        } catch {
          console.warn('telnyx-voice: ws send failed, call may have ended')
          break
        }

        // pace the output to match real-time playback
        await new Promise(r => setTimeout(r, frameMs))
      }
    } catch (err) {
      console.error('telnyx-voice: TTS send error:', err)
    }
  }

  // extract raw PCM samples and sample rate from a WAV file buffer
  function extractPcmFromWav(wav: Buffer): { samples: Buffer; sampleRate: number } | null {
    if (wav.toString('ascii', 0, 4) !== 'RIFF') return null
    if (wav.toString('ascii', 8, 12) !== 'WAVE') return null

    let offset = 12
    let sampleRate = 0
    let dataStart = 0
    let dataSize = 0

    while (offset < wav.length - 8) {
      const chunkId = wav.toString('ascii', offset, offset + 4)
      const chunkSize = wav.readUInt32LE(offset + 4)

      if (chunkId === 'fmt ') {
        sampleRate = wav.readUInt32LE(offset + 12)
      } else if (chunkId === 'data') {
        dataStart = offset + 8
        dataSize = chunkSize
        break
      }

      offset += 8 + chunkSize
    }

    if (!sampleRate || !dataStart) return null
    return {
      samples: wav.subarray(dataStart, dataStart + dataSize),
      sampleRate,
    }
  }

  // simple linear interpolation resampler
  function resamplePcm(input: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) return input

    const inputSamples = input.length / 2 // 16-bit
    const outputSamples = Math.floor(inputSamples * toRate / fromRate)
    const output = Buffer.alloc(outputSamples * 2)

    for (let i = 0; i < outputSamples; i++) {
      const srcIdx = i * fromRate / toRate
      const idx0 = Math.floor(srcIdx)
      const idx1 = Math.min(idx0 + 1, inputSamples - 1)
      const frac = srcIdx - idx0

      const s0 = input.readInt16LE(idx0 * 2)
      const s1 = input.readInt16LE(idx1 * 2)
      const sample = Math.round(s0 + frac * (s1 - s0))
      output.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
    }

    return output
  }

  // encode 16-bit PCM to mu-law
  function encodeMuLaw(pcm: Buffer): Buffer {
    const MULAW_MAX = 0x1fff
    const MULAW_BIAS = 33
    const out = Buffer.alloc(pcm.length / 2)

    for (let i = 0; i < pcm.length; i += 2) {
      let sample = pcm.readInt16LE(i)
      const sign = sample < 0 ? 0x80 : 0
      if (sign) sample = -sample
      sample = Math.min(sample, MULAW_MAX)
      sample += MULAW_BIAS

      let exponent = 7
      const expMask = 0x4000
      for (let j = 0; j < 8; j++) {
        if (sample & expMask) break
        exponent--
        sample <<= 1
      }

      const mantissa = (sample >> (exponent + 3)) & 0x0f
      const mulaw = ~(sign | (exponent << 4) | mantissa) & 0xff
      out[i / 2] = mulaw
    }

    return out
  }

  // encode 16-bit PCM to a-law
  function encodeALaw(pcm: Buffer): Buffer {
    const out = Buffer.alloc(pcm.length / 2)

    for (let i = 0; i < pcm.length; i += 2) {
      let sample = pcm.readInt16LE(i)
      const sign = sample < 0 ? 0x00 : 0x80
      if (sample < 0) sample = -sample - 1
      if (sample > 32767) sample = 32767

      let exponent = 0
      let expVal = sample >> 8
      while (expVal > 0) {
        exponent++
        expVal >>= 1
      }

      let mantissa: number
      if (exponent === 0) {
        mantissa = (sample >> 4) & 0x0f
      } else {
        mantissa = (sample >> (exponent + 3)) & 0x0f
      }

      const alaw = (sign | (exponent << 4) | mantissa) ^ 0x55
      out[i / 2] = alaw
    }

    return out
  }

  // --- webhook handler ---

  async function handleWebhook(event: TelnyxWebhookEvent) {
    const { event_type, payload } = event.data
    const callControlId = payload.call_control_id

    console.log(`telnyx-voice: webhook ${event_type} for call ${callControlId}`)

    switch (event_type) {
      case 'call.initiated': {
        if (payload.direction === 'incoming') {
          console.log(`telnyx-voice: incoming call from ${payload.from} to ${payload.to}`)
          activeCalls.set(callControlId, {
            callControlId,
            streamId: null,
            from: payload.from,
            to: payload.to,
            ws: null,
            mediaFormat: null,
            audioChunks: [],
            audioStartTime: null,
            lastAudioTime: 0,
            silenceStart: null,
            isProcessing: false,
            pendingAudio: [],
            abortController: null,
            textBuffer: '',
          })
          await answerCall(callControlId)
        } else if (payload.direction === 'outgoing') {
          // outbound call — already registered by createOutboundCall, just log
          console.log(`telnyx-voice: outbound call initiated to ${payload.to}`)
          if (!activeCalls.has(callControlId)) {
            // shouldn't happen, but handle race condition
            activeCalls.set(callControlId, {
              callControlId,
              streamId: null,
              from: payload.from,
              to: payload.to,
              ws: null,
              mediaFormat: null,
              audioChunks: [],
              audioStartTime: null,
              lastAudioTime: 0,
              silenceStart: null,
              isProcessing: false,
              pendingAudio: [],
              abortController: null,
              textBuffer: '',
            })
          }
        }
        break
      }

      case 'call.answered': {
        console.log(`telnyx-voice: call answered ${callControlId}`)
        // for outbound calls, the media stream is set up at call creation time
        // via stream_url, so no extra action needed here
        break
      }

      case 'call.hangup':
      case 'call.machine.detection.ended': {
        console.log(`telnyx-voice: call ended ${callControlId}`)
        const call = activeCalls.get(callControlId)
        if (call) {
          if (call.streamId) streamToCall.delete(call.streamId)
          call.abortController?.abort()
          activeCalls.delete(callControlId)
        }
        break
      }

      case 'streaming.started': {
        console.log(`telnyx-voice: streaming started for ${callControlId}`)
        break
      }

      case 'streaming.stopped': {
        console.log(`telnyx-voice: streaming stopped for ${callControlId}`)
        break
      }
    }
  }

  // --- media websocket handler ---

  function handleMediaWsMessage(ws: ServerWebSocket<WsData>, raw: string) {
    let msg: TelnyxWsMessage
    try {
      msg = JSON.parse(raw)
    } catch {
      console.warn('telnyx-voice: invalid ws message')
      return
    }

    switch (msg.event) {
      case 'connected': {
        console.log(`telnyx-voice: media ws connected (protocol v${msg.version})`)
        break
      }

      case 'start': {
        const { call_control_id, media_format } = msg.start
        const streamId = msg.stream_id

        console.log(`telnyx-voice: stream started for call ${call_control_id}, ` +
          `format: ${media_format.encoding}/${media_format.sample_rate}Hz/${media_format.channels}ch`)

        // associate this websocket with the call
        ws.data.callControlId = call_control_id
        const call = activeCalls.get(call_control_id)
        if (call) {
          call.ws = ws
          call.streamId = streamId
          call.mediaFormat = {
            encoding: media_format.encoding,
            sampleRate: media_format.sample_rate,
            channels: media_format.channels,
          }
          streamToCall.set(streamId, call_control_id)
        } else {
          console.warn(`telnyx-voice: stream start for unknown call ${call_control_id}`)
        }
        break
      }

      case 'media': {
        const callControlId = ws.data.callControlId
        if (!callControlId) return

        const call = activeCalls.get(callControlId)
        if (!call) return

        // decode the audio payload
        const audioData = Buffer.from(msg.media.payload, 'base64')
        const now = Date.now()

        // log first audio chunk for diagnostics
        if (!call.audioStartTime) {
          const hexPreview = audioData.subarray(0, 16).toString('hex')
          const enc = call.mediaFormat?.encoding || '?'
          const readSample = (b: Buffer, i: number) => b.readInt16LE(i)
          const bytesPerSample = enc === 'L16' ? 2 : 1
          const firstSamples: number[] = []
          for (let i = 0; i < Math.min(audioData.length, 20) - 1; i += bytesPerSample) {
            firstSamples.push(bytesPerSample === 2 ? readSample(audioData, i) : audioData[i]!)
          }
          console.log(`telnyx-voice: first audio chunk: ${audioData.length} bytes, encoding=${enc}, hex=${hexPreview}, samples=[${firstSamples.join(',')}]`)
        }

        // track audio timing for VAD
        if (!call.audioStartTime) {
          call.audioStartTime = now
        }
        call.lastAudioTime = now

        // voice activity detection
        const isSilent = detectSilence(call, audioData)
        const silenceThreshold = config!.silenceThresholdMs || 700

        if (isSilent) {
          if (!call.silenceStart) {
            call.silenceStart = now
          }

          // if silence exceeds threshold and we have audio, trigger processing
          if (now - call.silenceStart >= silenceThreshold && call.audioChunks.length > 0) {
            call.silenceStart = null
            call.audioStartTime = null
            processAudioPipeline(call).catch(err => {
              console.error('telnyx-voice: pipeline error:', err)
            })
          }
        } else {
          call.silenceStart = null
          // buffer audio
          if (call.isProcessing) {
            call.pendingAudio.push(audioData)
          } else {
            call.audioChunks.push(audioData)
          }
        }
        break
      }

      case 'stop': {
        const callControlId = ws.data.callControlId
        if (callControlId) {
          console.log(`telnyx-voice: stream stopped for call ${callControlId}`)
          const call = activeCalls.get(callControlId)
          if (call) {
            // process any remaining audio
            if (call.audioChunks.length > 0) {
              processAudioPipeline(call).catch(console.error)
            }
          }
        }
        break
      }
    }
  }

  // --- servers ---

  let webhookServer: ReturnType<typeof Bun.serve> | null = null
  let mediaWsServer: ReturnType<typeof Bun.serve> | null = null

  // silence check interval — periodically trigger transcription for accumulated audio
  let silenceCheckInterval: ReturnType<typeof setInterval> | null = null

  function startSilenceChecker() {
    silenceCheckInterval = setInterval(() => {
      const now = Date.now()
      const silenceThreshold = config!.silenceThresholdMs || 700

      for (const [, call] of activeCalls) {
        if (call.isProcessing) continue
        if (call.audioChunks.length === 0) continue

        // if we haven't received audio in a while, trigger processing
        if (now - call.lastAudioTime >= silenceThreshold) {
          call.silenceStart = null
          call.audioStartTime = null
          processAudioPipeline(call).catch(console.error)
        }
      }
    }, 100) // check every 100ms
  }

  // --- channel plugin interface ---

  async function* inputGenerator(): AsyncGenerator<QueuedInput> {
    while (true) {
      while (messageQueue.length > 0) {
        yield messageQueue.shift()!
      }
      await new Promise<void>(resolve => {
        resolveWaiter = resolve
      })
    }
  }

  // output handler: receives agent response and converts to speech
  async function handleOutput(sessionId: string, message: any) {
    // sessionId here is the callControlId
    const call = activeCalls.get(sessionId)
    if (!call) return

    if (message.type === 'text') {
      // buffer text until we get a text_block_end or enough for a sentence
      call.textBuffer += message.text

      // check for sentence boundaries for streaming TTS
      const sentenceEnd = call.textBuffer.search(/[.!?]\s|[.!?]$|\n/)
      if (sentenceEnd !== -1) {
        const sentence = call.textBuffer.slice(0, sentenceEnd + 1).trim()
        call.textBuffer = call.textBuffer.slice(sentenceEnd + 1)
        if (sentence) {
          await sendTtsToCall(sentence, call)
        }
      }
    } else if (message.type === 'text_block_end') {
      // flush remaining text
      const remaining = call.textBuffer
      call.textBuffer = ''
      if (remaining.trim()) {
        await sendTtsToCall(remaining.trim(), call)
      }
    }
    // ignore tool_use, tool_result, done, error for voice output
  }

  return {
    name: 'telnyx-voice',
    description: [
      'Real-time phone conversation via Telnyx voice API.',
      'When receiving phone calls, user speech is transcribed and sent as messages prefixed with [phone call from <number>].',
      'You can also make outbound calls using the phone_call tool.',
      'Your text responses are automatically converted to speech and played back to the caller.',
      'Keep voice responses concise and conversational — the caller hears them spoken aloud.',
    ].join(' '),

    tools: [
      {
        name: 'phone_call',
        description: 'Make an outbound phone call. The call will be connected to your voice conversation just like incoming calls.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Phone number to call (E.164 format, e.g. +15551234567)' },
            purpose: { type: 'string', description: 'Brief context about why you are making this call (for your own reference)' },
          },
          required: ['to'],
        },
        async execute(input: unknown) {
          const { to, purpose } = input as { to: string; purpose?: string }
          try {
            const callControlId = await createOutboundCall(to)
            const msg = purpose
              ? `calling ${to} (${purpose}), call_control_id: ${callControlId}`
              : `calling ${to}, call_control_id: ${callControlId}`
            return { content: msg }
          } catch (err: any) {
            return { content: `failed to place call: ${err.message}`, is_error: true }
          }
        },
      },
      {
        name: 'phone_hangup',
        description: 'Hang up an active phone call.',
        inputSchema: {
          type: 'object',
          properties: {
            call_id: { type: 'string', description: 'The call control ID to hang up. If not provided, hangs up the most recent call.' },
          },
        },
        async execute(input: unknown) {
          const { call_id } = input as { call_id?: string }
          let targetId = call_id

          if (!targetId) {
            // find the most recent active call
            const calls = [...activeCalls.keys()]
            targetId = calls[calls.length - 1]
          }

          if (!targetId || !activeCalls.has(targetId)) {
            return { content: 'no active call to hang up', is_error: true }
          }

          await hangupCall(targetId)
          return { content: `hanging up call ${targetId}` }
        },
      },
      {
        name: 'phone_status',
        description: 'Get the status of active phone calls.',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          if (activeCalls.size === 0) {
            return { content: 'no active calls' }
          }

          const lines = [...activeCalls.values()].map(c =>
            `- ${c.callControlId}: ${c.from} → ${c.to} (stream: ${c.streamId ? 'active' : 'pending'})`
          )
          return { content: `active calls:\n${lines.join('\n')}` }
        },
      },
    ],

    input: inputGenerator(),

    output: handleOutput,

    async init(cfg: unknown) {
      config = cfg as TelnyxVoiceConfig
      if (!config?.apiKey) {
        console.warn('telnyx-voice: no API key configured')
        return
      }

      const webhookPort = config.webhookPort || 8089
      const mediaWsPort = config.mediaWsPort || 8090

      // start webhook server
      webhookServer = Bun.serve({
        port: webhookPort,
        async fetch(req) {
          const url = new URL(req.url)

          if (url.pathname === '/health') {
            return new Response('ok')
          }

          if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/')) {
            try {
              const body = await req.json() as TelnyxWebhookEvent
              // handle async so we don't block the webhook response
              handleWebhook(body).catch(err => {
                console.error('telnyx-voice: webhook handler error:', err)
              })
              return new Response('ok', { status: 200 })
            } catch (err) {
              console.error('telnyx-voice: webhook parse error:', err)
              return new Response('bad request', { status: 400 })
            }
          }

          return new Response('not found', { status: 404 })
        },
      })
      console.log(`telnyx-voice: webhook server on port ${webhookPort}`)

      // start media websocket server
      mediaWsServer = Bun.serve<WsData>({
        port: mediaWsPort,
        fetch(req, server) {
          const upgraded = server.upgrade(req, {
            data: { callControlId: null },
          })
          if (!upgraded) {
            return new Response('WebSocket upgrade failed', { status: 500 })
          }
          return undefined
        },
        websocket: {
          open(ws) {
            console.log('telnyx-voice: media ws connection opened')
          },
          message(ws, message) {
            handleMediaWsMessage(ws, message.toString())
          },
          close(ws) {
            console.log('telnyx-voice: media ws connection closed')
            if (ws.data.callControlId) {
              const call = activeCalls.get(ws.data.callControlId)
              if (call) {
                call.ws = null
              }
            }
          },
        },
      })
      console.log(`telnyx-voice: media ws server on port ${mediaWsPort}`)

      // start silence checker
      startSilenceChecker()

      // start whisper server in the background (don't block init)
      ensureWhisperServer().catch(err => {
        console.error('telnyx-voice: failed to start whisper server:', err)
      })
    },

    async destroy() {
      if (silenceCheckInterval) {
        clearInterval(silenceCheckInterval)
        silenceCheckInterval = null
      }

      // hang up all active calls
      for (const [id, call] of activeCalls) {
        call.abortController?.abort()
        await hangupCall(id).catch(() => {})
      }
      activeCalls.clear()
      streamToCall.clear()

      webhookServer?.stop()
      mediaWsServer?.stop()
      webhookServer = null
      mediaWsServer = null

      // stop whisper server
      if (whisperServerProcess) {
        whisperServerProcess.kill()
        whisperServerProcess = null
        whisperServerReady = false
      }
    },
  }
}
