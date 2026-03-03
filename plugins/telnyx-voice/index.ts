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
import { transcribe, ensureWhisperServer, stopWhisperServer, ensureTtsServer, speak, speakStreaming, stopTtsServer, type TtsOptions } from '../../server/services/index.ts'

interface TelnyxVoiceConfig {
  apiKey: string                    // telnyx API key (v2)
  connectionId?: string             // telnyx Call Control App ID (required for outbound calls)
  fromNumber?: string               // telnyx phone number (for outbound calls)
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
  voiceSeed?: number                // torch random seed for consistent voice across TTS calls
  voiceTemperature?: number         // sampling temperature (lower = more consistent, default: 0.3)
  // recording settings
  recordCalls?: boolean             // record call audio (default: true)
  recordingsPath?: string           // directory for recordings (default: ~/.toebeans/telnyx-voice/call-recordings/)
  retentionDays?: number            // auto-delete recordings older than this many days
  // DSP-based DTMF detection
  dtmfThreshold?: number            // Goertzel power threshold (default: 100000000)
  dtmfMinDurationMs?: number        // minimum tone duration in ms (default: 150)
  dtmfInterDigitMs?: number         // minimum gap between digits in ms (default: 100)
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

  // promise chain for serializing TTS frame sending per call
  ttsSending: Promise<void>

  // optional message to speak via TTS when the call connects
  initialMessage: string | null

  // recording state
  recording: {
    inboundChunks: Buffer[]
    outboundChunks: Buffer[]
    startTime: number  // Date.now() when recording started
  } | null

  // DSP-based DTMF detector
  dtmfDetector: DtmfDetector | null
}

interface WsData {
  callControlId: string | null
}

// message queue for channel plugin input
interface QueuedInput {
  message: { role: 'user'; content: Array<{ type: 'text'; text: string }> }
  outputTarget: string
}

// debug logger for outgoing audio pipeline
const audioLog = {
  _t0: 0,
  reset() { this._t0 = performance.now() },
  // elapsed ms since reset, for relative timing
  elapsed(): string { return (performance.now() - this._t0).toFixed(1) },
  // absolute timestamp for log lines
  ts(): string { return new Date().toISOString().slice(11, 23) },
}

// --- Goertzel-based DTMF detector ---
// detects DTMF tones directly from 16-bit PCM audio using the Goertzel algorithm,
// which is efficient for detecting power at specific known frequencies.

const DTMF_ROW_FREQS = [697, 770, 852, 941] as const
const DTMF_COL_FREQS = [1209, 1336, 1477, 1633] as const
const DTMF_MAP: Record<string, string> = {
  '697:1209': '1', '697:1336': '2', '697:1477': '3', '697:1633': 'A',
  '770:1209': '4', '770:1336': '5', '770:1477': '6', '770:1633': 'B',
  '852:1209': '7', '852:1336': '8', '852:1477': '9', '852:1633': 'C',
  '941:1209': '*', '941:1336': '0', '941:1477': '#', '941:1633': 'D',
}

interface DtmfDetectorConfig {
  sampleRate: number
  threshold: number       // Goertzel power threshold
  minDurationMs: number   // minimum tone duration
  interDigitMs: number    // minimum gap between digits
}

class DtmfDetector {
  private config: DtmfDetectorConfig
  // precomputed Goertzel coefficients for each target frequency
  private coeffs: { freq: number; coeff: number }[]
  // state for tone tracking
  private currentDigit: string | null = null
  private digitStartMs: number = 0
  private lastEmitMs: number = 0
  private emitted: boolean = false  // whether we already emitted the current tone

  constructor(config: DtmfDetectorConfig) {
    this.config = config
    // precompute 2*cos(2*pi*f/sampleRate) for each frequency
    this.coeffs = [...DTMF_ROW_FREQS, ...DTMF_COL_FREQS].map(freq => ({
      freq,
      coeff: 2 * Math.cos((2 * Math.PI * freq) / config.sampleRate),
    }))
  }

  // compute Goertzel power for a single frequency over a block of samples
  private goertzelPower(samples: Int16Array, coeffIdx: number): number {
    const coeff = this.coeffs[coeffIdx]!.coeff
    let s0 = 0, s1 = 0, s2 = 0
    for (let i = 0; i < samples.length; i++) {
      s0 = coeff * s1 - s2 + samples[i]!
      s2 = s1
      s1 = s0
    }
    // power = s1^2 + s2^2 - coeff*s1*s2
    return s1 * s1 + s2 * s2 - coeff * s1 * s2
  }

  // process a chunk of L16 PCM audio. returns detected digits (usually 0 or 1).
  process(pcmBuffer: Buffer): string[] {
    const digits: string[] = []
    const now = performance.now()

    // interpret buffer as 16-bit signed LE samples
    const samples = new Int16Array(
      pcmBuffer.buffer,
      pcmBuffer.byteOffset,
      pcmBuffer.length / 2,
    )

    if (samples.length === 0) return digits

    // compute power at all 8 DTMF frequencies
    const powers = this.coeffs.map((_, i) => this.goertzelPower(samples, i))

    // find strongest row (indices 0-3) and column (indices 4-7)
    let maxRowPower = 0, maxRowIdx = -1
    for (let i = 0; i < 4; i++) {
      if (powers[i]! > maxRowPower) {
        maxRowPower = powers[i]!
        maxRowIdx = i
      }
    }
    let maxColPower = 0, maxColIdx = -1
    for (let i = 4; i < 8; i++) {
      if (powers[i]! > maxColPower) {
        maxColPower = powers[i]!
        maxColIdx = i
      }
    }

    // both row and column must exceed threshold
    let detectedDigit: string | null = null
    if (maxRowPower >= this.config.threshold && maxColPower >= this.config.threshold) {
      // twist ratio check: row/column power must be close to equal (~0.6 to 1.8 ratio)
      // real DTMF has two roughly equal-power tones; speech doesn't
      const twist = maxRowPower / maxColPower
      if (twist < 0.6 || twist > 1.8) {
        detectedDigit = null
      } else {
        // energy ratio check: DTMF frequencies should dominate the signal
        // sum all 8 DTMF bin powers and compare against total signal energy
        const dtmfEnergy = powers.reduce((sum, p) => sum + p, 0)
        let totalEnergy = 0
        for (let i = 0; i < samples.length; i++) {
          totalEnergy += samples[i]! * samples[i]!
        }
        // DTMF tones should carry >75% of total energy; speech is broadband
        if (totalEnergy > 0 && dtmfEnergy / totalEnergy < 0.75) {
          detectedDigit = null
        } else {
          const rowFreq = DTMF_ROW_FREQS[maxRowIdx]
          const colFreq = DTMF_COL_FREQS[maxColIdx - 4]
          detectedDigit = DTMF_MAP[`${rowFreq}:${colFreq}`] ?? null
        }
      }
    }

    if (detectedDigit) {
      if (detectedDigit === this.currentDigit) {
        // same tone continuing — check if held long enough to emit
        if (!this.emitted && now - this.digitStartMs >= this.config.minDurationMs) {
          // also enforce inter-digit gap from last emitted digit
          if (now - this.lastEmitMs >= this.config.interDigitMs) {
            digits.push(detectedDigit)
            this.emitted = true
            this.lastEmitMs = now
          }
        }
      } else {
        // new tone started
        this.currentDigit = detectedDigit
        this.digitStartMs = now
        this.emitted = false
      }
    } else {
      // no valid tone detected — reset
      this.currentDigit = null
      this.emitted = false
    }

    return digits
  }
}

export default function create(serverContext?: any) {
  let config: TelnyxVoiceConfig | null = null
  const activeCalls = new Map<string, ActiveCall>() // callControlId → ActiveCall
  const streamToCall = new Map<string, string>()     // streamId → callControlId

  // message queue for channel plugin input (transcribed speech → agent)
  const messageQueue: QueuedInput[] = []
  let resolveWaiter: (() => void) | null = null

  // --- recording helpers ---

  function getRecordingsDir(): string {
    return config?.recordingsPath || `${process.env.HOME}/.toebeans/telnyx-voice/call-recordings`
  }

  function shouldRecord(): boolean {
    return config?.recordCalls !== false // default true
  }

  function initRecording(call: ActiveCall) {
    if (!shouldRecord()) return
    call.recording = {
      inboundChunks: [],
      outboundChunks: [],
      startTime: Date.now(),
    }
    console.log(`telnyx-voice: recording started for call ${call.callControlId}`)
  }

  function recordInbound(call: ActiveCall, audioData: Buffer) {
    if (call.recording) {
      call.recording.inboundChunks.push(audioData)
    }
  }

  function recordOutbound(call: ActiveCall, audioData: Buffer) {
    if (call.recording) {
      call.recording.outboundChunks.push(audioData)
    }
  }

  async function finalizeRecording(call: ActiveCall) {
    if (!call.recording) return

    const rec = call.recording
    call.recording = null

    const inboundPcm = Buffer.concat(rec.inboundChunks)
    const outboundPcm = Buffer.concat(rec.outboundChunks)

    if (inboundPcm.length === 0 && outboundPcm.length === 0) {
      console.log(`telnyx-voice: no audio recorded for call ${call.callControlId}, skipping save`)
      return
    }

    const sampleRate = call.mediaFormat?.sampleRate || 8000
    const encoding = call.mediaFormat?.encoding || 'L16'

    // convert to 16-bit LE PCM if needed
    const inboundPcm16 = encodingToPcm16(inboundPcm, encoding)
    const outboundPcm16 = encodingToPcm16(outboundPcm, encoding)

    // create stereo WAV: left = inbound (remote), right = outbound (local)
    const maxLen = Math.max(inboundPcm16.length, outboundPcm16.length)
    const stereoSamples = maxLen / 2 // number of samples per channel
    const stereoPcm = Buffer.alloc(stereoSamples * 4) // 2 channels × 2 bytes

    for (let i = 0; i < stereoSamples; i++) {
      const inSample = i * 2 < inboundPcm16.length ? inboundPcm16.readInt16LE(i * 2) : 0
      const outSample = i * 2 < outboundPcm16.length ? outboundPcm16.readInt16LE(i * 2) : 0
      stereoPcm.writeInt16LE(inSample, i * 4)       // left channel
      stereoPcm.writeInt16LE(outSample, i * 4 + 2)  // right channel
    }

    // build WAV
    const numChannels = 2
    const bitsPerSample = 16
    const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
    const blockAlign = numChannels * (bitsPerSample / 8)
    const dataSize = stereoPcm.length
    const headerSize = 44
    const wav = Buffer.alloc(headerSize + dataSize)

    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + dataSize, 4)
    wav.write('WAVE', 8)
    wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(numChannels, 22)
    wav.writeUInt32LE(sampleRate, 24)
    wav.writeUInt32LE(byteRate, 28)
    wav.writeUInt16LE(blockAlign, 32)
    wav.writeUInt16LE(bitsPerSample, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(dataSize, 40)
    stereoPcm.copy(wav, 44)

    // save to disk
    const startDate = new Date(rec.startTime)
    const dateDir = startDate.toISOString().slice(0, 10) // YYYY-MM-DD
    const timestamp = startDate.toISOString().replace(/[:.]/g, '-')
    const callIdShort = call.callControlId.slice(0, 12)
    const dir = `${getRecordingsDir()}/${dateDir}`
    const baseName = `call-${callIdShort}-${timestamp}`
    const wavPath = `${dir}/${baseName}.wav`
    const metaPath = `${dir}/${baseName}.json`

    try {
      await Bun.file(dir + '/.keep').exists() || await Bun.$`mkdir -p ${dir}`.quiet()

      await Bun.write(wavPath, wav)

      const durationSec = stereoSamples / sampleRate
      const metadata = {
        callControlId: call.callControlId,
        from: call.from,
        to: call.to,
        startTime: startDate.toISOString(),
        durationSeconds: Math.round(durationSec * 10) / 10,
        sampleRate,
        encoding,
        format: 'stereo WAV (L=inbound, R=outbound)',
        inboundBytes: inboundPcm.length,
        outboundBytes: outboundPcm.length,
      }
      await Bun.write(metaPath, JSON.stringify(metadata, null, 2))

      console.log(`telnyx-voice: recording saved: ${wavPath} (${durationSec.toFixed(1)}s, ${(wav.length / 1024).toFixed(0)}KB)`)
    } catch (err) {
      console.error(`telnyx-voice: failed to save recording:`, err)
    }
  }

  function encodingToPcm16(data: Buffer, encoding: string): Buffer {
    if (encoding === 'PCMU') return decodeMuLaw(data)
    if (encoding === 'PCMA') return decodeALaw(data)
    return data // L16 is already 16-bit LE PCM
  }

  async function cleanOldRecordings() {
    const days = config?.retentionDays
    if (!days || days <= 0) return

    const baseDir = getRecordingsDir()
    const cutoff = Date.now() - days * 86400000

    try {
      const { readdir, stat, unlink, rmdir } = await import('node:fs/promises')
      const dateDirs = await readdir(baseDir).catch(() => [] as string[])

      for (const dateDir of dateDirs) {
        // parse YYYY-MM-DD directory names
        const dirDate = new Date(dateDir + 'T00:00:00Z')
        if (isNaN(dirDate.getTime())) continue
        if (dirDate.getTime() > cutoff) continue

        const dirPath = `${baseDir}/${dateDir}`
        const files = await readdir(dirPath).catch(() => [] as string[])
        for (const file of files) {
          await unlink(`${dirPath}/${file}`).catch(() => {})
        }
        await rmdir(dirPath).catch(() => {})
        console.log(`telnyx-voice: cleaned old recordings from ${dateDir}`)
      }
    } catch (err) {
      console.error('telnyx-voice: retention cleanup error:', err)
    }
  }

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

  // send DTMF tones on an active call
  // digits: 0-9, A-D, *, #, w (0.5s pause), W (1s pause)
  async function sendDtmf(callControlId: string, digits: string, durationMs?: number) {
    console.log(`telnyx-voice: sending DTMF "${digits}" on call ${callControlId}`)
    const body: Record<string, unknown> = { digits }
    if (durationMs) body.duration_millis = Math.max(100, Math.min(500, durationMs))
    const res = await telnyxApi('POST', `/calls/${callControlId}/actions/send_dtmf`, body)
    if (!res.ok) {
      const err = await res.text()
      console.error(`telnyx-voice: DTMF send failed: ${res.status} ${err}`)
      throw new Error(`DTMF send failed: ${res.status} ${err}`)
    }
    // wait for tones to play out before returning
    // each digit ~duration_millis (default ~250ms), pauses are w=500ms W=1000ms
    const perDigitMs = durationMs || 250
    let totalMs = 0
    for (const ch of digits) {
      if (ch === 'w') totalMs += 500
      else if (ch === 'W') totalMs += 1000
      else totalMs += perDigitMs
    }
    await new Promise(r => setTimeout(r, totalMs))
  }

  async function createOutboundCall(to: string, initialMessage?: string): Promise<string> {
    if (!config!.connectionId) {
      throw new Error('connectionId not configured — required for outbound calls (this is your Call Control App ID in the Telnyx portal)')
    }
    if (!config!.fromNumber) {
      throw new Error('fromNumber not configured — required as caller ID for outbound calls')
    }
    if (!config!.publicHost) {
      throw new Error('publicHost not configured — required for media streaming')
    }

    const codec = config!.streamBidirectionalCodec || 'L16'
    const streamUrl = `wss://${config!.publicHost}/media`

    const res = await telnyxApi('POST', '/calls', {
      connection_id: config!.connectionId,
      to,
      from: config!.fromNumber,
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
      from: config!.fromNumber!,
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
      ttsSending: Promise.resolve(),
      initialMessage: initialMessage ?? null,
      recording: null,
      dtmfDetector: null,
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
      // build WAV in memory and send to shared whisper service
      const wavBuffer = createWavBuffer(audioBuffer, sampleRate, encoding)
      const transcription = await transcribe(wavBuffer)

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

  // --- TTS output: generate speech and send back through telnyx websocket ---

  // send pre-encoded audio frames over the websocket, paced to real-time.
  // returns the wall-clock time the first frame was sent (for latency tracking).
  async function sendFramesToCall(encodedAudio: Buffer, call: ActiveCall): Promise<number> {
    if (!call.ws) {
      console.warn('telnyx-voice/audio-out: no websocket for call, cannot send frames')
      return 0
    }

    // record all outbound audio
    recordOutbound(call, encodedAudio)

    const callSampleRate = call.mediaFormat?.sampleRate || 8000
    const callEncoding = call.mediaFormat?.encoding || 'L16'
    const bytesPerSample = callEncoding === 'L16' ? 2 : 1
    const frameMs = 20
    const frameSamples = callSampleRate * frameMs / 1000
    const frameBytes = frameSamples * bytesPerSample

    // pad audio to exact frame boundary to avoid sending a partial final frame
    // (an undersized RTP frame causes clicks or dropped audio)
    const remainder = encodedAudio.length % frameBytes
    if (remainder !== 0) {
      const padded = Buffer.alloc(encodedAudio.length + (frameBytes - remainder))
      encodedAudio.copy(padded)
      encodedAudio = padded
    }

    const totalFrames = encodedAudio.length / frameBytes
    const expectedDurationMs = totalFrames * frameMs

    const sendStart = performance.now()
    let framesSent = 0
    let sendErrors = 0

    for (let offset = 0, frameIndex = 0; offset < encodedAudio.length; offset += frameBytes, frameIndex++) {
      const chunk = encodedAudio.subarray(offset, offset + frameBytes)
      const payload = chunk.toString('base64')

      try {
        call.ws.send(JSON.stringify({
          event: 'media',
          media: { payload },
        }))
        framesSent++
      } catch (err) {
        sendErrors++
        if (sendErrors <= 3) {
          console.warn(`telnyx-voice/audio-out [${audioLog.ts()}]: ws send failed at frame ${framesSent}/${totalFrames}: ${err}`)
        }
        if (sendErrors >= 5) {
          console.error(`telnyx-voice/audio-out: aborting send after ${sendErrors} errors`)
          break
        }
      }

      // pace using absolute timestamps to prevent setTimeout drift accumulation
      const nextFrameTime = sendStart + (frameIndex + 1) * frameMs
      const sleepMs = nextFrameTime - performance.now()
      if (sleepMs > 0) {
        await new Promise(r => setTimeout(r, sleepMs))
      }
    }

    const actualDurationMs = performance.now() - sendStart
    const drift = actualDurationMs - expectedDurationMs
    console.log(`telnyx-voice/audio-out [${audioLog.ts()}]: sent ${framesSent}/${totalFrames} frames in ${actualDurationMs.toFixed(0)}ms ` +
      `(drift ${drift > 0 ? '+' : ''}${drift.toFixed(0)}ms${sendErrors > 0 ? `, ${sendErrors} errors` : ''})`)

    return sendStart
  }

  function getTtsOpts(): TtsOptions {
    return {
      language: 'english',
      voiceInstruct: config?.voiceInstruct,
      instruct: config?.voiceInstruct,
      seed: config?.voiceSeed,
      temperature: config?.voiceTemperature ?? 0.3,
      subtalkerTemperature: config?.voiceTemperature ?? 0.3,
    }
  }

  // stream TTS: send text to /tts/stream, receive PCM chunks, resample+encode+send
  // each chunk in real-time as it arrives. serialized through call.ttsSending so
  // multiple calls play back-to-back without overlap.
  async function streamTtsToCall(text: string, call: ActiveCall) {
    if (!call.ws) {
      console.warn(`telnyx-voice/audio-out [${audioLog.ts()}]: no websocket for call, cannot stream TTS`)
      return
    }

    const textPreview = text.length > 60 ? text.slice(0, 57) + '...' : text

    // chain through call.ttsSending so concurrent calls serialize
    call.ttsSending = call.ttsSending.then(async () => {
      const streamStart = performance.now()
      console.log(`telnyx-voice/audio-out [${audioLog.ts()}]: streaming TTS "${textPreview}" (${text.length} chars)`)

      const callSampleRate = call.mediaFormat?.sampleRate || 8000
      const callEncoding = call.mediaFormat?.encoding || 'L16'
      const TTS_SOURCE_RATE = 24000 // speakStreaming yields int16 LE @ 24kHz

      // accumulate resampled+encoded audio until we have enough for a batch of frames,
      // then send them paced to real-time. this avoids per-chunk overhead while still
      // streaming — we send frames as soon as we have them rather than waiting for
      // the full response.
      let pendingPcm = Buffer.alloc(0) // resampled PCM waiting to be framed
      let totalBytesSent = 0
      let firstFrameTime = 0
      let chunkCount = 0

      // how much resampled audio (in bytes) we accumulate before flushing to frames.
      // ~200ms worth keeps the pipeline smooth without adding perceptible latency.
      const bytesPerSample = callEncoding === 'L16' ? 2 : 1
      const flushBytes = Math.ceil(callSampleRate * 0.2) * bytesPerSample

      function encodeForWire(resampled: Buffer): Buffer {
        if (callEncoding === 'PCMU') return encodeMuLaw(resampled)
        if (callEncoding === 'PCMA') return encodeALaw(resampled)
        return resampled // L16 already LE
      }

      async function flushPending() {
        if (pendingPcm.length === 0) return
        const encoded = encodeForWire(pendingPcm)
        pendingPcm = Buffer.alloc(0)
        const t = await sendFramesToCall(encoded, call)
        if (!firstFrameTime && t) firstFrameTime = t
        totalBytesSent += encoded.length
      }

      try {
        for await (const chunk of speakStreaming(text, getTtsOpts())) {
          chunkCount++
          // chunk is raw int16 LE PCM @ 24kHz — resample to call rate
          const resampled = resamplePcm(chunk, TTS_SOURCE_RATE, callSampleRate)
          // append to pending buffer
          pendingPcm = Buffer.concat([pendingPcm, resampled])

          if (pendingPcm.length >= flushBytes) {
            await flushPending()
          }
        }

        // flush any remaining audio
        await flushPending()

        const elapsed = performance.now() - streamStart
        const audioDurationMs = (totalBytesSent / bytesPerSample / callSampleRate) * 1000
        const ttfaMs = firstFrameTime ? (firstFrameTime - streamStart).toFixed(0) : 'n/a'
        console.log(`telnyx-voice/audio-out [${audioLog.ts()}]: stream done: ${chunkCount} chunks, ` +
          `${audioDurationMs.toFixed(0)}ms audio, TTFA ${ttfaMs}ms, total ${elapsed.toFixed(0)}ms`)
      } catch (err) {
        console.error(`telnyx-voice/audio-out [${audioLog.ts()}]: streaming TTS error:`, err)
      }
    }).catch(err => {
      console.error(`telnyx-voice/audio-out [${audioLog.ts()}]: TTS send chain error:`, err)
    })
  }

  // non-streaming TTS for short utterances (initial messages, etc.)
  async function sendTtsToCall(text: string, call: ActiveCall) {
    if (!call.ws) {
      console.warn(`telnyx-voice/audio-out [${audioLog.ts()}]: no websocket for call, cannot send TTS`)
      return
    }

    call.ttsSending = call.ttsSending.then(async () => {
      const genStart = performance.now()
      const textPreview = text.length > 60 ? text.slice(0, 57) + '...' : text
      console.log(`telnyx-voice/audio-out [${audioLog.ts()}]: TTS request "${textPreview}" (${text.length} chars)`)

      try {
        const wavData = await speak(text, getTtsOpts())
        const pcmData = extractPcmFromWav(wavData)
        if (!pcmData) {
          console.error('telnyx-voice/audio-out: failed to extract PCM from TTS WAV')
          return
        }
        const callSampleRate = call.mediaFormat?.sampleRate || 8000
        const callEncoding = call.mediaFormat?.encoding || 'L16'
        const resampled = resamplePcm(pcmData.samples, pcmData.sampleRate, callSampleRate)
        let encoded = resampled
        if (callEncoding === 'PCMU') encoded = encodeMuLaw(resampled)
        else if (callEncoding === 'PCMA') encoded = encodeALaw(resampled)

        const elapsed = performance.now() - genStart
        console.log(`telnyx-voice/audio-out [${audioLog.ts()}]: TTS generated in ${elapsed.toFixed(0)}ms, sending ${encoded.length} bytes`)
        await sendFramesToCall(encoded, call)
      } catch (err) {
        console.error(`telnyx-voice/audio-out [${audioLog.ts()}]: TTS error:`, err)
      }
    }).catch(err => {
      console.error(`telnyx-voice/audio-out [${audioLog.ts()}]: TTS send chain error:`, err)
    })
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

  // resample 16-bit PCM with anti-aliasing low-pass filter.
  // when downsampling (e.g. 24kHz→8kHz), frequencies above the nyquist of the
  // target rate alias back as audible distortion. we apply a windowed-sinc FIR
  // filter before interpolating to prevent this.
  function resamplePcm(input: Buffer, fromRate: number, toRate: number): Buffer {
    if (fromRate === toRate) return input

    const inputSamples = input.length / 2 // 16-bit

    // read input samples into a float array for filtering
    const inp = new Float64Array(inputSamples)
    for (let i = 0; i < inputSamples; i++) {
      inp[i] = input.readInt16LE(i * 2)
    }

    // when downsampling, low-pass filter the input first to prevent aliasing
    let filtered = inp
    if (toRate < fromRate) {
      // cutoff at target nyquist frequency (relative to input sample rate)
      const cutoff = toRate / fromRate // e.g. 8000/24000 = 0.333
      // FIR filter length — longer = steeper rolloff, diminishing returns past ~32
      const halfLen = 16
      const kernel = new Float64Array(halfLen * 2 + 1)
      let kernelSum = 0
      for (let j = -halfLen; j <= halfLen; j++) {
        // windowed sinc: sinc(cutoff * j) * blackman(j)
        const sinc = j === 0 ? cutoff : Math.sin(Math.PI * cutoff * j) / (Math.PI * j)
        const x = (j + halfLen) / (halfLen * 2)
        const blackman = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x)
        kernel[j + halfLen] = sinc * blackman
        kernelSum += sinc * blackman
      }
      // normalize kernel
      for (let j = 0; j < kernel.length; j++) kernel[j]! /= kernelSum

      filtered = new Float64Array(inputSamples)
      for (let i = 0; i < inputSamples; i++) {
        let sum = 0
        for (let j = -halfLen; j <= halfLen; j++) {
          const idx = i + j
          if (idx >= 0 && idx < inputSamples) {
            sum += inp[idx]! * kernel[j + halfLen]!
          }
        }
        filtered[i] = sum
      }
    }

    // interpolate to target rate
    const outputSamples = Math.floor(inputSamples * toRate / fromRate)
    const output = Buffer.alloc(outputSamples * 2)

    for (let i = 0; i < outputSamples; i++) {
      const srcIdx = i * fromRate / toRate
      const idx0 = Math.floor(srcIdx)
      const idx1 = Math.min(idx0 + 1, inputSamples - 1)
      const frac = srcIdx - idx0

      const sample = Math.round(filtered[idx0]! + frac * (filtered[idx1]! - filtered[idx0]!))
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
            ttsSending: Promise.resolve(),
            initialMessage: null,
            recording: null,
            dtmfDetector: null,
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
              ttsSending: Promise.resolve(),
              initialMessage: null,
              recording: null,
              dtmfDetector: null,
            })
          }
        }
        break
      }



      case 'call.answered': {
        console.log(`telnyx-voice: call answered ${callControlId}`)
        // eagerly start TTS server so it's warm by the time the LLM generates a response
        ensureTtsServer()
        // for outbound calls, the media stream is set up at call creation time
        // via stream_url, so no extra action needed here
        break
      }

      case 'call.hangup':
      case 'call.machine.detection.ended': {
        console.log(`telnyx-voice: call ended ${callControlId}`)
        const call = activeCalls.get(callControlId)
        if (call) {
          // finalize recording before cleaning up
          finalizeRecording(call).catch(err => {
            console.error('telnyx-voice: recording finalize error:', err)
          })
          if (call.streamId) streamToCall.delete(call.streamId)
          call.abortController?.abort()
          activeCalls.delete(callControlId)
        }
        break
      }

      case 'call.dtmf.received': {
        const call = activeCalls.get(callControlId)
        if (call) {
          const digit = payload.digit as string
          console.log(`telnyx-voice: DTMF received from ${call.from}: ${digit}`)
          queueMessage(`[DTMF from ${call.from}]: ${digit}`, callControlId)
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
          initRecording(call)

          // initialize DSP-based DTMF detector for this call
          call.dtmfDetector = new DtmfDetector({
            sampleRate: media_format.sample_rate,
            threshold: config!.dtmfThreshold ?? 100000000,
            minDurationMs: config!.dtmfMinDurationMs ?? 150,
            interDigitMs: config!.dtmfInterDigitMs ?? 100,
          })

          // if this is an outbound call with an initial message, speak it now
          if (call.initialMessage) {
            const msg = call.initialMessage
            call.initialMessage = null // consume it so it doesn't replay
            console.log(`telnyx-voice: sending initial message for outbound call ${call_control_id}: "${msg}"`)
            ensureTtsServer()
            sendTtsToCall(msg, call)
          }
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

        // record all inbound audio (before VAD, so we capture everything)
        recordInbound(call, audioData)

        // DSP-based DTMF detection — run on every inbound audio frame,
        // DTMF is always processed (works as interrupt even during AI speech)
        if (call.dtmfDetector) {
          // Goertzel needs L16 PCM; convert if necessary
          const pcm16 = encodingToPcm16(audioData, call.mediaFormat?.encoding || 'L16')
          const digits = call.dtmfDetector.process(pcm16)
          for (const digit of digits) {
            console.log(`telnyx-voice: DTMF detected (DSP) from ${call.from}: ${digit}`)
            queueMessage(`[DTMF from ${call.from}]: ${digit}`, callControlId)
          }
        }

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

  // --- DTMF parsing ---
  // matches [DTMF: ...] markers in text, e.g. [DTMF: 1w23#]
  const DTMF_PATTERN = /\[DTMF:\s*([0-9A-D*#wW,\s]+)\]/gi

  interface TextSegment { type: 'text'; text: string }
  interface DtmfSegment { type: 'dtmf'; digits: string }
  type ResponseSegment = TextSegment | DtmfSegment

  // split a response into alternating text and DTMF segments
  function parseResponseSegments(text: string): ResponseSegment[] {
    const segments: ResponseSegment[] = []
    let lastIndex = 0

    for (const match of text.matchAll(DTMF_PATTERN)) {
      const matchStart = match.index!
      // text before this DTMF marker
      if (matchStart > lastIndex) {
        const before = text.slice(lastIndex, matchStart).trim()
        if (before) segments.push({ type: 'text', text: before })
      }
      // normalize digits: strip whitespace, convert commas to w (0.5s pause)
      const digits = match[1]!.replace(/[\s]/g, '').replace(/,/g, 'w')
      segments.push({ type: 'dtmf', digits })
      lastIndex = matchStart + match[0].length
    }

    // trailing text
    if (lastIndex < text.length) {
      const after = text.slice(lastIndex).trim()
      if (after) segments.push({ type: 'text', text: after })
    }

    return segments
  }

  // process mixed text+DTMF: stream text segments via TTS, send DTMF segments via API
  async function sendMixedResponse(text: string, call: ActiveCall) {
    const segments = parseResponseSegments(text)

    // if no DTMF markers, just stream the whole thing
    if (segments.length === 1 && segments[0]!.type === 'text') {
      await streamTtsToCall(segments[0]!.text, call)
      return
    }

    for (const seg of segments) {
      if (seg.type === 'text') {
        await streamTtsToCall(seg.text, call)
        // wait for TTS to finish playing before sending DTMF
        await call.ttsSending
      } else {
        console.log(`telnyx-voice: sending DTMF segment: ${seg.digits}`)
        await sendDtmf(call.callControlId, seg.digits)
      }
    }
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

  // output handler: receives agent response and converts to speech.
  // buffers all streaming text, then sends the full response to streaming TTS
  // on text_block_end. no sentence splitting — the TTS server handles the full
  // text and streams audio chunks back as they're generated.
  let outputSeq = 0
  async function handleOutput(sessionId: string, message: any) {
    // sessionId here is the callControlId
    const call = activeCalls.get(sessionId)
    if (!call) return

    if (message.type === 'text') {
      call.textBuffer += message.text
    } else if (message.type === 'text_block_end') {
      const text = call.textBuffer.trim()
      call.textBuffer = ''
      if (text) {
        const seq = ++outputSeq
        console.log(`telnyx-voice/audio-out [${audioLog.ts()}]: output #${seq}: "${text.length > 80 ? text.slice(0, 77) + '...' : text}" (${text.length} chars)`)
        audioLog.reset()
        await sendMixedResponse(text, call)
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
      '\n\nDTMF (phone menu navigation):',
      'To send DTMF tones during a call, use the send_dtmf tool or embed [DTMF: digits] in your text response.',
      'Valid digits: 0-9, *, #, A-D. Use commas or w for 0.5s pauses between digits.',
      'Example: "Let me press 1 for billing. [DTMF: 1] Now waiting for the next menu."',
      'The text before and after DTMF markers will be spoken via TTS; the DTMF tones are sent in between.',
      'When navigating IVR menus, narrate what you are doing so the user can follow along.',
      '\n\nIMPORTANT: [DTMF: X] markers in your response SEND actual tones to the caller.',
      'When you detect DTMF digits from the user, acknowledge them in text but do NOT include [DTMF: X] markers in your response — those markers SEND tones back to the caller.',
      'Only use [DTMF: X] when YOU intentionally want to send a tone (e.g. navigating an IVR menu on behalf of the user).',
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
            initialMessage: { type: 'string', description: 'Message to speak via TTS as soon as the call connects, before waiting for the other party to speak' },
          },
          required: ['to'],
        },
        async execute(input: unknown) {
          const { to, purpose, initialMessage } = input as { to: string; purpose?: string; initialMessage?: string }
          try {
            const callControlId = await createOutboundCall(to, initialMessage)
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
        name: 'send_dtmf',
        description: 'Send DTMF tones on an active phone call. Use this to navigate phone menus (IVR systems). Digits: 0-9, *, #, A-D. Use w for a 0.5s pause, W for a 1s pause between digits.',
        inputSchema: {
          type: 'object',
          properties: {
            digits: { type: 'string', description: 'DTMF digits to send (0-9, *, #, A-D, w/W for pauses). Example: "1w2w3" sends 1, pauses, 2, pauses, 3.' },
            call_id: { type: 'string', description: 'Call control ID. If not provided, uses the most recent active call.' },
            duration_ms: { type: 'number', description: 'Duration per digit in ms (100-500, default 250).' },
          },
          required: ['digits'],
        },
        async execute(input: unknown) {
          const { digits, call_id, duration_ms } = input as { digits: string; call_id?: string; duration_ms?: number }

          // validate digits
          if (!/^[0-9A-D*#wW]+$/.test(digits)) {
            return { content: 'invalid DTMF digits. valid: 0-9, A-D, *, #, w (0.5s pause), W (1s pause)', is_error: true }
          }

          let targetId = call_id
          if (!targetId) {
            const calls = [...activeCalls.keys()]
            targetId = calls[calls.length - 1]
          }
          if (!targetId || !activeCalls.has(targetId)) {
            return { content: 'no active call to send DTMF on', is_error: true }
          }

          try {
            await sendDtmf(targetId, digits, duration_ms)
            return { content: `sent DTMF "${digits}" on call ${targetId}` }
          } catch (err: any) {
            return { content: `DTMF failed: ${err.message}`, is_error: true }
          }
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
          close(ws, code, reason) {
            console.log(`telnyx-voice: media ws connection closed (code=${code}, reason=${reason || 'none'}, call=${ws.data.callControlId || 'unknown'})`)
            if (ws.data.callControlId) {
              const call = activeCalls.get(ws.data.callControlId)
              if (call) {
                call.ws = null
                console.log(`telnyx-voice/audio-out: ws closed for call ${ws.data.callControlId} — any pending TTS will fail`)
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

      // clean up old recordings in the background
      cleanOldRecordings().catch(err => {
        console.error('telnyx-voice: retention cleanup failed:', err)
      })
    },

    async destroy() {
      if (silenceCheckInterval) {
        clearInterval(silenceCheckInterval)
        silenceCheckInterval = null
      }

      // finalize recordings and hang up all active calls
      for (const [id, call] of activeCalls) {
        await finalizeRecording(call).catch(() => {})
        call.abortController?.abort()
        await hangupCall(id).catch(() => {})
      }
      activeCalls.clear()
      streamToCall.clear()

      webhookServer?.stop()
      mediaWsServer?.stop()
      webhookServer = null
      mediaWsServer = null

      // stop shared services (no-op if another plugin is still using them)
      await stopWhisperServer()
      await stopTtsServer()
    },
  }
}
