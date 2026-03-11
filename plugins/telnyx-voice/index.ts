// telnyx-voice: ground-up redesign with aggressive pipelining
//
// architecture (inspired by shuo):
//   audio in → VAD → whisper → agent (LLM streaming) → TTS streaming → audio out
//   every stage streams into the next. no waiting for completion.
//
// key differences from previous version:
//   - LLM tokens stream directly into TTS (sentence-level chunking)
//   - barge-in cancels the entire pipeline instantly via AbortController
//   - fresh toebeans session per call
//   - cleaner state machine: LISTENING | RESPONDING
//
// v2.1 fixes (choppy/missing audio):
//   - reduced TTS flush buffer from 200ms to 60ms to eliminate micro-stutters
//   - first TTS chunk flushes immediately (0-latency TTFA)
//   - barge-in sends clear command to Telnyx to stop buffered audio playback
//   - accumulated text from LLM streaming is batched into fewer TTS calls to
//     avoid per-sentence cold starts
//
// v2.2 fixes (residual stutter + multi-paragraph truncation):
//   - bumped flush buffer from 60ms to 120ms (user accepted slight latency for
//     smoother audio; 120ms is still under conversational perception threshold)
//   - streaming sentence detector now also splits on paragraph breaks (\n\n)
//   - text is normalized before TTS: \n\n → ". ", \n → " " — prevents TTS model
//     from stopping generation at paragraph boundaries
//   - fixed indexOf(' ') returning -1 on \n\n-separated text (garbled splits)
//
// v3.0 fix (stutter from coupled TTS ingestion + frame pacing):
//   - root cause: streamTtsToCall consumed TTS chunks, but flush() awaited
//     sendFrames() which paced in real-time. while blocked, TTS audio
//     accumulated upstream, then got read in bursts → worsening stutter.
//   - fix: AudioQueue decouples TTS ingestion from frame pacing.
//     producer: TTS consumer loop pushes pre-sliced frames into a ring buffer.
//     consumer: independent 20ms timer loop pulls one frame per tick and sends.
//     on underrun the consumer waits (no silence injection — avoids pops/clicks,
//     a brief natural pause is less disruptive for phone audio).

import type { ServerWebSocket } from 'bun'
import { join, dirname, resolve } from 'path'

// types — we only need the shapes, declare them inline to avoid import issues
interface ContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface Message {
  role: 'user' | 'assistant'
  content: ContentBlock[]
}

interface ServerMessage {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  usage?: unknown
  cost?: unknown
  message?: string
  metadata?: Record<string, unknown>
}

interface Plugin {
  name: string
  description?: string
  tools?: any[]
  input?: AsyncIterable<any>
  output?: (sessionId: string, message: ServerMessage) => Promise<void>
  init?: (config: unknown) => void | Promise<void>
  destroy?: () => void | Promise<void>
}

interface TtsOptions {
  language?: string
  instruct?: string
  voiceInstruct?: string
  seed?: number
  temperature?: number
  subtalkerTemperature?: number
}

// resolve the toebeans source directory at runtime.
// Bun.main is the entry point (e.g. /home/neynt/code/toebeans/server/index.ts)
const TOEBEANS_SRC = resolve(dirname(Bun.main), '..')

const services = await import(join(TOEBEANS_SRC, 'server/services/index.ts'))
const { transcribe, ensureWhisperServer, ensureTtsServer, speakStreaming } = services as {
  transcribe: (wav: Buffer) => Promise<string>
  ensureWhisperServer: () => Promise<void>
  ensureTtsServer: (opts?: TtsOptions) => Promise<void>
  speakStreaming: (text: string, opts?: TtsOptions) => AsyncGenerator<Buffer>
}

// ── config ──

interface Config {
  apiKey: string
  connectionId?: string
  fromNumber?: string
  webhookPort?: number       // default 8091
  mediaWsPort?: number       // default 8092
  publicHost?: string
  streamBidirectionalCodec?: string  // L16, PCMU (default L16)
  sampleRate?: number        // 8000 or 16000 (default 8000)
  silenceThresholdMs?: number  // default 700
  silenceEnergyThreshold?: number  // RMS threshold, default 200
  voiceInstruct?: string
  voiceSeed?: number
  voiceTemperature?: number  // default 0.3
  model?: string             // LLM model, default 'sonnet'
  recordCalls?: boolean      // default true
}

// ── telnyx protocol types ──

interface TelnyxMediaStart {
  event: 'start'
  start: {
    call_control_id: string
    media_format: { encoding: string; sample_rate: number; channels: number }
  }
  stream_id: string
}

interface TelnyxMediaPayload {
  event: 'media'
  media: { payload: string }
  stream_id: string
}

type TelnyxWsMessage =
  | { event: 'connected'; version: string }
  | TelnyxMediaStart
  | TelnyxMediaPayload
  | { event: 'stop'; stream_id: string }

interface TelnyxWebhookEvent {
  data: {
    event_type: string
    payload: {
      call_control_id: string
      from: string
      to: string
      direction: string
      digit?: string
      [key: string]: unknown
    }
  }
}

// ── call state machine ──

type CallPhase = 'listening' | 'responding'

interface ActiveCall {
  callControlId: string
  streamId: string | null
  from: string
  to: string
  ws: ServerWebSocket<WsData> | null
  mediaFormat: { encoding: string; sampleRate: number; channels: number } | null

  // session
  sessionId: string

  // state machine
  phase: CallPhase

  // audio accumulation for VAD
  audioChunks: Buffer[]
  lastAudioTime: number
  silenceStart: number | null

  // pipeline cancellation
  pipelineAbort: AbortController | null

  // TTS serialization: chains TTS calls so they produce audio back-to-back
  ttsSending: Promise<void>

  // decoupled audio queue: TTS pushes frames, consumer timer sends them
  audioQueue: AudioQueue
  consumerTimer: ReturnType<typeof setInterval> | null

  // text accumulator during LLM streaming
  textBuffer: string
  // how much of the response was spoken before interruption
  spokenText: string

  // outbound call initial message
  initialMessage: string | null

  // recording
  recording: { inbound: Buffer[]; outbound: Buffer[]; start: number } | null

  // DTMF detector
  dtmfDetector: DtmfDetector | null
}

interface WsData {
  callControlId: string | null
}

// ── DTMF detector (Goertzel) ──

const DTMF_ROW_FREQS = [697, 770, 852, 941] as const
const DTMF_COL_FREQS = [1209, 1336, 1477, 1633] as const
const DTMF_MAP: Record<string, string> = {
  '697:1209': '1', '697:1336': '2', '697:1477': '3', '697:1633': 'A',
  '770:1209': '4', '770:1336': '5', '770:1477': '6', '770:1633': 'B',
  '852:1209': '7', '852:1336': '8', '852:1477': '9', '852:1633': 'C',
  '941:1209': '*', '941:1336': '0', '941:1477': '#', '941:1633': 'D',
}

class DtmfDetector {
  private coeffs: { freq: number; coeff: number }[]
  private threshold: number
  private minDurationMs: number
  private interDigitMs: number
  private currentDigit: string | null = null
  private digitStartMs = 0
  private lastEmitMs = 0
  private emitted = false

  constructor(sampleRate: number, threshold = 100000000, minDurationMs = 150, interDigitMs = 100) {
    this.threshold = threshold
    this.minDurationMs = minDurationMs
    this.interDigitMs = interDigitMs
    this.coeffs = [...DTMF_ROW_FREQS, ...DTMF_COL_FREQS].map(freq => ({
      freq,
      coeff: 2 * Math.cos((2 * Math.PI * freq) / sampleRate),
    }))
  }

  private goertzelPower(samples: Int16Array, idx: number): number {
    const coeff = this.coeffs[idx]!.coeff
    let s0 = 0, s1 = 0, s2 = 0
    for (let i = 0; i < samples.length; i++) {
      s0 = coeff * s1 - s2 + samples[i]!
      s2 = s1
      s1 = s0
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2
  }

  process(pcmBuffer: Buffer): string[] {
    const digits: string[] = []
    const now = performance.now()
    const samples = new Int16Array(pcmBuffer.buffer, pcmBuffer.byteOffset, pcmBuffer.length / 2)
    if (samples.length === 0) return digits

    const powers = this.coeffs.map((_, i) => this.goertzelPower(samples, i))

    let maxRowPower = 0, maxRowIdx = -1
    for (let i = 0; i < 4; i++) {
      if (powers[i]! > maxRowPower) { maxRowPower = powers[i]!; maxRowIdx = i }
    }
    let maxColPower = 0, maxColIdx = -1
    for (let i = 4; i < 8; i++) {
      if (powers[i]! > maxColPower) { maxColPower = powers[i]!; maxColIdx = i - 4 }
    }

    const detected = maxRowPower > this.threshold && maxColPower > this.threshold
    if (detected) {
      const key = `${DTMF_ROW_FREQS[maxRowIdx]}:${DTMF_COL_FREQS[maxColIdx]}`
      const digit = DTMF_MAP[key]
      if (digit) {
        if (digit !== this.currentDigit) {
          this.currentDigit = digit
          this.digitStartMs = now
          this.emitted = false
        } else if (!this.emitted && now - this.digitStartMs >= this.minDurationMs && now - this.lastEmitMs >= this.interDigitMs) {
          digits.push(digit)
          this.emitted = true
          this.lastEmitMs = now
        }
      }
    } else {
      this.currentDigit = null
    }
    return digits
  }
}

// ── AudioQueue: decoupled producer/consumer frame buffer ──
//
// the producer (TTS consumer loop) pushes pre-sliced encoded frames.
// the consumer (20ms timer) pulls one frame per tick and sends it.
// generation tracking ensures stale frames from cancelled TTS don't leak.

class AudioQueue {
  private frames: Buffer[] = []
  private generation = 0

  // stats (reset per clear)
  totalPushed = 0
  totalPulled = 0
  peakDepth = 0
  underruns = 0

  /** current number of queued frames */
  get depth(): number { return this.frames.length }

  /** current generation — callers snapshot this to detect cancellation */
  get gen(): number { return this.generation }

  /** push a single encoded frame. no-op if generation has changed since snapshot. */
  push(frame: Buffer, gen: number) {
    if (gen !== this.generation) return  // stale push from cancelled TTS
    this.frames.push(frame)
    this.totalPushed++
    if (this.frames.length > this.peakDepth) this.peakDepth = this.frames.length
  }

  /** pull the next frame, or null if empty (underrun). */
  pull(): Buffer | null {
    const frame = this.frames.shift() ?? null
    if (frame) {
      this.totalPulled++
    } else {
      this.underruns++
    }
    return frame
  }

  /** clear all queued frames and bump generation (invalidates in-flight pushes). */
  clear() {
    this.frames.length = 0
    this.generation++
    this.totalPushed = 0
    this.totalPulled = 0
    this.peakDepth = 0
    this.underruns = 0
  }
}

// ── audio codec helpers ──

function decodeMuLaw(data: Buffer): Buffer {
  const BIAS = 33
  const out = Buffer.alloc(data.length * 2)
  for (let i = 0; i < data.length; i++) {
    let mu = ~data[i]! & 0xff
    const sign = mu & 0x80
    const exp = (mu >> 4) & 0x07
    let mantissa = ((((mu & 0x0f) << 1) + 1 + BIAS) << (exp + 2)) - BIAS
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sign ? -mantissa : mantissa)), i * 2)
  }
  return out
}

function decodeALaw(data: Buffer): Buffer {
  const out = Buffer.alloc(data.length * 2)
  for (let i = 0; i < data.length; i++) {
    let alaw = data[i]! ^ 0x55
    const sign = alaw & 0x80
    alaw &= 0x7f
    const exp = (alaw >> 4) & 0x07
    const mantissa = alaw & 0x0f
    let sample = exp === 0
      ? (mantissa * 2 + 1) << 3
      : (mantissa * 2 + 1 + 32) << (exp + 2)
    if (sign) sample = -sample
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
  }
  return out
}

function encodeMuLaw(pcm: Buffer): Buffer {
  const MAX = 0x1fff, BIAS = 33
  const out = Buffer.alloc(pcm.length / 2)
  for (let i = 0; i < pcm.length; i += 2) {
    let s = pcm.readInt16LE(i)
    const sign = s < 0 ? 0x80 : 0
    if (sign) s = -s
    s = Math.min(s, MAX) + BIAS
    let exp = 7
    for (let j = 0; j < 8; j++) { if (s & 0x4000) break; exp--; s <<= 1 }
    out[i / 2] = ~(sign | (exp << 4) | ((s >> (exp + 3)) & 0x0f)) & 0xff
  }
  return out
}

function encodeALaw(pcm: Buffer): Buffer {
  const out = Buffer.alloc(pcm.length / 2)
  for (let i = 0; i < pcm.length; i += 2) {
    let s = pcm.readInt16LE(i)
    const sign = s < 0 ? 0x00 : 0x80
    if (s < 0) s = -s - 1
    if (s > 32767) s = 32767
    let exp = 0, v = s >> 8
    while (v > 0) { exp++; v >>= 1 }
    const mantissa = exp === 0 ? (s >> 4) & 0x0f : (s >> (exp + 3)) & 0x0f
    out[i / 2] = (sign | (exp << 4) | mantissa) ^ 0x55
  }
  return out
}

function toPcm16(data: Buffer, encoding: string): Buffer {
  if (encoding === 'PCMU') return decodeMuLaw(data)
  if (encoding === 'PCMA') return decodeALaw(data)
  return data
}

function fromPcm16(data: Buffer, encoding: string): Buffer {
  if (encoding === 'PCMU') return encodeMuLaw(data)
  if (encoding === 'PCMA') return encodeALaw(data)
  return data
}

// ── DSP: resampler with anti-aliasing ──

function resamplePcm(input: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return input
  const n = input.length / 2
  const inp = new Float64Array(n)
  for (let i = 0; i < n; i++) inp[i] = input.readInt16LE(i * 2)

  let filtered = inp
  if (toRate < fromRate) {
    const cutoff = toRate / fromRate
    const half = 16
    const kernel = new Float64Array(half * 2 + 1)
    let sum = 0
    for (let j = -half; j <= half; j++) {
      const sinc = j === 0 ? cutoff : Math.sin(Math.PI * cutoff * j) / (Math.PI * j)
      const x = (j + half) / (half * 2)
      const win = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x)
      kernel[j + half] = sinc * win
      sum += sinc * win
    }
    for (let j = 0; j < kernel.length; j++) kernel[j]! /= sum
    filtered = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let s = 0
      for (let j = -half; j <= half; j++) {
        const idx = i + j
        if (idx >= 0 && idx < n) s += inp[idx]! * kernel[j + half]!
      }
      filtered[i] = s
    }
  }

  const outN = Math.floor(n * toRate / fromRate)
  const out = Buffer.alloc(outN * 2)
  for (let i = 0; i < outN; i++) {
    const srcIdx = i * fromRate / toRate
    const i0 = Math.floor(srcIdx)
    const i1 = Math.min(i0 + 1, n - 1)
    const frac = srcIdx - i0
    const sample = Math.round(filtered[i0]! + frac * (filtered[i1]! - filtered[i0]!))
    out.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2)
  }
  return out
}

// ── WAV builder ──

function buildWav(pcm16: Buffer, sampleRate: number): Buffer {
  const bps = 16, ch = 1
  const byteRate = sampleRate * ch * bps / 8
  const blockAlign = ch * bps / 8
  const wav = Buffer.alloc(44 + pcm16.length)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + pcm16.length, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(ch, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(byteRate, 28)
  wav.writeUInt16LE(blockAlign, 32)
  wav.writeUInt16LE(bps, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(pcm16.length, 40)
  pcm16.copy(wav, 44)
  return wav
}

// ── DTMF parsing in responses ──

const DTMF_PATTERN = /\[DTMF:\s*([0-9A-D*#wW,\s]+)\]/gi

interface TextSegment { type: 'text'; text: string }
interface DtmfSegment { type: 'dtmf'; digits: string }
type ResponseSegment = TextSegment | DtmfSegment

// normalize text for TTS: collapse paragraph breaks and newlines into
// speech-friendly punctuation so the TTS model doesn't choke on \n\n.
// exported-shape helper (tested separately).
function normalizeTextForTts(text: string): string {
  return text
    // paragraph breaks → period + space (adds sentence boundary if missing)
    .replace(/([.!?;])\s*\n\n+\s*/g, '$1 ')   // "sentence.\n\n" → "sentence. "
    .replace(/\n\n+\s*/g, '. ')                  // "word\n\n" → "word. "
    // remaining single newlines → space
    .replace(/\n/g, ' ')
    // collapse multiple spaces
    .replace(/ {2,}/g, ' ')
    .trim()
}

function parseResponseSegments(text: string): ResponseSegment[] {
  const segments: ResponseSegment[] = []
  let lastIndex = 0
  for (const match of text.matchAll(DTMF_PATTERN)) {
    const start = match.index!
    if (start > lastIndex) {
      const t = text.slice(lastIndex, start).trim()
      if (t) segments.push({ type: 'text', text: t })
    }
    segments.push({ type: 'dtmf', digits: match[1]!.replace(/\s/g, '').replace(/,/g, 'w') })
    lastIndex = start + match[0].length
  }
  if (lastIndex < text.length) {
    const t = text.slice(lastIndex).trim()
    if (t) segments.push({ type: 'text', text: t })
  }
  return segments
}

// ── logging ──

const log = {
  ts: () => new Date().toISOString().slice(11, 23),
  info: (tag: string, msg: string) => console.log(`tv2/${tag} [${log.ts()}]: ${msg}`),
  warn: (tag: string, msg: string) => console.warn(`tv2/${tag} [${log.ts()}]: ${msg}`),
  err: (tag: string, msg: string, e?: unknown) => console.error(`tv2/${tag} [${log.ts()}]: ${msg}`, e ?? ''),
}

// ── plugin ──

export default function create(_serverContext?: any) {
  let config: Config | null = null
  const activeCalls = new Map<string, ActiveCall>()
  const streamToCall = new Map<string, string>()

  // channel plugin message queue
  const messageQueue: Array<{
    message: Message
    outputTarget: string
    metadata?: Record<string, unknown>
  }> = []
  let resolveWaiter: (() => void) | null = null

  let webhookServer: ReturnType<typeof Bun.serve> | null = null
  let mediaWsServer: ReturnType<typeof Bun.serve> | null = null
  let silenceCheckInterval: ReturnType<typeof setInterval> | null = null

  // ── telnyx REST API ──

  function telnyxApi(method: string, path: string, body?: unknown): Promise<Response> {
    return fetch(`https://api.telnyx.com/v2${path}`, {
      method,
      headers: {
        'Authorization': `Bearer ${config!.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    })
  }

  // ── call lifecycle ──

  async function answerCall(callControlId: string) {
    const host = config!.publicHost
    if (!host) {
      log.err('webhook', 'publicHost not configured, cannot answer call')
      return
    }
    const codec = config!.streamBidirectionalCodec || 'L16'
    const streamUrl = `wss://${host}/media`
    log.info('webhook', `answering call ${callControlId} stream_url=${streamUrl}`)

    const res = await telnyxApi('POST', `/calls/${callControlId}/actions/answer`, {
      stream_url: streamUrl,
      stream_track: 'inbound_track',
      stream_bidirectional_mode: 'rtp',
      stream_bidirectional_codec: codec,
      client_state: Buffer.from(JSON.stringify({ plugin: 'telnyx-voice' })).toString('base64'),
    })
    if (!res.ok) {
      log.err('webhook', `answer failed: ${res.status} ${await res.text()}`)
    }
  }

  async function hangupCall(callControlId: string) {
    try {
      await telnyxApi('POST', `/calls/${callControlId}/actions/hangup`, {})
    } catch (e) {
      log.err('call', `hangup failed`, e)
    }
  }

  async function sendDtmf(callControlId: string, digits: string, durationMs?: number) {
    log.info('dtmf', `sending "${digits}" on ${callControlId}`)
    const body: Record<string, unknown> = { digits }
    if (durationMs) body.duration_millis = Math.max(100, Math.min(500, durationMs))
    const res = await telnyxApi('POST', `/calls/${callControlId}/actions/send_dtmf`, body)
    if (!res.ok) {
      const err = await res.text()
      throw new Error(`DTMF send failed: ${res.status} ${err}`)
    }
    // wait for tones to play
    let totalMs = 0
    for (const ch of digits) {
      if (ch === 'w') totalMs += 500
      else if (ch === 'W') totalMs += 1000
      else totalMs += (durationMs || 250)
    }
    await new Promise(r => setTimeout(r, totalMs))
  }

  // clear the Telnyx audio playback buffer for a call.
  // used during barge-in to immediately stop audio the caller hears,
  // even for frames we've already sent over the WebSocket.
  async function clearCallAudio(callControlId: string) {
    try {
      // Telnyx doesn't have a "clear audio buffer" API. send a brief burst of
      // silence to flush the Telnyx-side jitter buffer, pushing out any
      // remaining agent audio frames that were already sent over the wire.
      const call = activeCalls.get(callControlId)
      if (!call?.ws) return

      const rate = call.mediaFormat?.sampleRate || 8000
      const enc = call.mediaFormat?.encoding || 'L16'
      const bps = enc === 'L16' ? 2 : 1
      const frameMs = 20
      const frameBytes = rate * frameMs / 1000 * bps
      // send ~100ms of silence (5 frames) to flush any jitter buffer
      const silenceFrames = 5
      const silence = Buffer.alloc(frameBytes)
      for (let i = 0; i < silenceFrames; i++) {
        try {
          call.ws.send(JSON.stringify({ event: 'media', media: { payload: silence.toString('base64') } }))
        } catch {
          break
        }
      }
    } catch (e) {
      log.warn('barge-in', `clearCallAudio error: ${e}`)
    }
  }

  function makeCall(callControlId: string, from: string, to: string, initialMessage?: string): ActiveCall {
    const call: ActiveCall = {
      callControlId,
      streamId: null,
      from, to,
      ws: null,
      mediaFormat: null,
      sessionId: '', // set in initCallSession (for recordings/logging only)
      phase: 'listening',
      audioChunks: [],
      lastAudioTime: 0,
      silenceStart: null,
      pipelineAbort: null,
      ttsSending: Promise.resolve(),
      audioQueue: new AudioQueue(),
      consumerTimer: null,
      textBuffer: '',
      spokenText: '',
      initialMessage: initialMessage ?? null,
      recording: null,
      dtmfDetector: null,
    }
    activeCalls.set(callControlId, call)
    return call
  }

  function initCallSession(call: ActiveCall) {
    // the actual LLM session is managed by the server (via outputTarget routing).
    // we track a reference ID for recordings/logging. the server creates the real
    // session when the first message arrives via the channel plugin input.
    call.sessionId = `tv2-${call.callControlId}`
    log.info('session', `call ${call.callControlId}: tracking as ${call.sessionId}`)
  }

  function cleanupCall(call: ActiveCall) {
    call.pipelineAbort?.abort()
    stopConsumer(call)
    call.audioQueue.clear()
    if (call.streamId) streamToCall.delete(call.streamId)
    if (call.recording) {
      saveRecording(call).catch(e => log.err('recording', 'save failed', e))
    }
    activeCalls.delete(call.callControlId)
    log.info('call', `cleaned up ${call.callControlId}`)
  }

  // ── recording ──

  function initRecording(call: ActiveCall) {
    if (config?.recordCalls === false) return
    call.recording = { inbound: [], outbound: [], start: Date.now() }
  }

  async function saveRecording(call: ActiveCall) {
    const rec = call.recording
    if (!rec) return
    call.recording = null

    const inPcm = Buffer.concat(rec.inbound)
    const outPcm = Buffer.concat(rec.outbound)
    if (inPcm.length === 0 && outPcm.length === 0) return

    const sampleRate = call.mediaFormat?.sampleRate || 8000
    const encoding = call.mediaFormat?.encoding || 'L16'
    const inPcm16 = toPcm16(inPcm, encoding)
    const outPcm16 = toPcm16(outPcm, encoding)

    const maxLen = Math.max(inPcm16.length, outPcm16.length)
    const stereoSamples = maxLen / 2
    const stereo = Buffer.alloc(stereoSamples * 4)
    for (let i = 0; i < stereoSamples; i++) {
      const inS = i * 2 < inPcm16.length ? inPcm16.readInt16LE(i * 2) : 0
      const outS = i * 2 < outPcm16.length ? outPcm16.readInt16LE(i * 2) : 0
      stereo.writeInt16LE(inS, i * 4)
      stereo.writeInt16LE(outS, i * 4 + 2)
    }

    const dir = `${process.env.HOME}/.toebeans/recordings/${new Date().toISOString().slice(0, 10)}`
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true })

    // save stereo WAV
    const bps = 16, ch = 2
    const byteRate = sampleRate * ch * bps / 8
    const blockAlign = ch * bps / 8
    const wavSize = 44 + stereo.length
    const wav = Buffer.alloc(wavSize)
    wav.write('RIFF', 0)
    wav.writeUInt32LE(36 + stereo.length, 4)
    wav.write('WAVE', 8)
    wav.write('fmt ', 12)
    wav.writeUInt32LE(16, 16)
    wav.writeUInt16LE(1, 20)
    wav.writeUInt16LE(ch, 22)
    wav.writeUInt32LE(sampleRate, 24)
    wav.writeUInt32LE(byteRate, 28)
    wav.writeUInt16LE(blockAlign, 32)
    wav.writeUInt16LE(bps, 34)
    wav.write('data', 36)
    wav.writeUInt32LE(stereo.length, 40)
    stereo.copy(wav, 44)

    const wavPath = `${dir}/call-${call.sessionId || call.callControlId}.wav`
    await Bun.write(wavPath, wav)
    log.info('recording', `saved ${wavPath} (${(stereo.length / sampleRate / ch / (bps / 8)).toFixed(1)}s)`)

    // save call metadata
    const meta = {
      callControlId: call.callControlId,
      sessionId: call.sessionId,
      from: call.from,
      to: call.to,
      startTime: new Date(rec.start).toISOString(),
      endTime: new Date().toISOString(),
      durationSeconds: (Date.now() - rec.start) / 1000,
    }
    await Bun.write(`${dir}/call-${call.sessionId || call.callControlId}.json`, JSON.stringify(meta, null, 2))
  }

  // ── VAD (voice activity detection) ──

  function detectSilence(call: ActiveCall, audioData: Buffer): boolean {
    const threshold = config!.silenceEnergyThreshold || 200
    const encoding = call.mediaFormat?.encoding || 'L16'
    const bytesPerSample = encoding === 'L16' ? 2 : 1
    const samples = audioData.length / bytesPerSample
    if (samples === 0) return true

    let sumSquares = 0
    for (let i = 0; i < audioData.length; i += bytesPerSample) {
      const sample = encoding === 'L16'
        ? audioData.readInt16LE(i)
        : (audioData[i]! - 128) * 256
      sumSquares += sample * sample
    }
    return Math.sqrt(sumSquares / samples) < threshold
  }

  // ── TTS output pipeline ──

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

  // slice encoded audio into 20ms frames and push into the call's AudioQueue.
  // non-blocking: returns immediately. the consumer timer sends them at pace.
  function pushFrames(encodedAudio: Buffer, call: ActiveCall, gen: number) {
    call.recording?.outbound.push(encodedAudio)

    const rate = call.mediaFormat?.sampleRate || 8000
    const enc = call.mediaFormat?.encoding || 'L16'
    const bps = enc === 'L16' ? 2 : 1
    const frameMs = 20
    const frameBytes = rate * frameMs / 1000 * bps

    // pad to frame boundary
    const remainder = encodedAudio.length % frameBytes
    if (remainder !== 0) {
      const padded = Buffer.alloc(encodedAudio.length + (frameBytes - remainder))
      encodedAudio.copy(padded)
      encodedAudio = padded
    }

    for (let off = 0; off < encodedAudio.length; off += frameBytes) {
      call.audioQueue.push(encodedAudio.subarray(off, off + frameBytes), gen)
    }
  }

  // start the consumer timer for a call. pulls one frame every 20ms and sends it.
  // on underrun (queue empty), just skips — no silence injection. for phone audio
  // a brief natural pause is less disruptive than injected silence (pops/clicks).
  function startConsumer(call: ActiveCall) {
    if (call.consumerTimer) return  // already running

    const frameMs = 20
    let sendStart = performance.now()
    let frameIndex = 0
    let maxDriftMs = 0
    let lateFrames = 0
    let consecutiveUnderruns = 0
    let totalSent = 0
    let lastStatsTime = performance.now()

    call.consumerTimer = setInterval(() => {
      if (!call.ws) return

      const frame = call.audioQueue.pull()
      if (!frame) {
        // underrun — nothing to send. just wait for producer to push more.
        consecutiveUnderruns++
        if (consecutiveUnderruns === 1) {
          // reset pacing origin on transition to underrun so we don't
          // try to "catch up" when audio becomes available again
          sendStart = 0
        }
        return
      }

      if (consecutiveUnderruns > 0) {
        if (consecutiveUnderruns > 5) {
          log.info('consumer', `resumed after ${consecutiveUnderruns} underruns (${(consecutiveUnderruns * frameMs)}ms gap), queue depth=${call.audioQueue.depth}`)
        }
        consecutiveUnderruns = 0
        // reset pacing origin on resume
        sendStart = performance.now()
        frameIndex = 0
      }

      try {
        call.ws.send(JSON.stringify({ event: 'media', media: { payload: frame.toString('base64') } }))
        totalSent++
        frameIndex++
      } catch {
        return
      }

      // drift tracking
      const expectedTime = sendStart + frameIndex * frameMs
      const drift = performance.now() - expectedTime
      if (drift > 5) {
        lateFrames++
        if (drift > maxDriftMs) maxDriftMs = drift
      }

      // periodic stats
      const now = performance.now()
      if (now - lastStatsTime > 5000) {
        const q = call.audioQueue
        log.info('consumer', `sent=${totalSent} depth=${q.depth} peak=${q.peakDepth} underruns=${q.underruns} maxDrift=${maxDriftMs.toFixed(0)}ms lateFrames=${lateFrames}`)
        lastStatsTime = now
        maxDriftMs = 0
        lateFrames = 0
      }
    }, frameMs)
  }

  function stopConsumer(call: ActiveCall) {
    if (!call.consumerTimer) return
    clearInterval(call.consumerTimer)
    call.consumerTimer = null
    const q = call.audioQueue
    if (q.totalPushed > 0) {
      log.info('consumer', `stopped: pushed=${q.totalPushed} pulled=${q.totalPulled} peak=${q.peakDepth} underruns=${q.underruns}`)
    }
  }

  // wait for the audio queue to drain (all pushed frames consumed).
  // used to detect when the caller has heard everything before transitioning
  // back to listening. polls at 50ms — good enough for state transitions.
  function waitForQueueDrain(call: ActiveCall): Promise<void> {
    return new Promise<void>(resolve => {
      const check = () => {
        if (call.audioQueue.depth === 0 || call.phase !== 'responding') {
          resolve()
        } else {
          setTimeout(check, 50)
        }
      }
      check()
    })
  }

  // stream a single text segment through TTS → resample → encode → push to queue.
  // serialized through call.ttsSending so TTS calls produce audio in order.
  // the consumer timer (startConsumer) sends frames at 20ms pace independently.
  //
  // v3.0: the producer no longer blocks on frame pacing. it just pushes frames
  // into the AudioQueue as fast as TTS generates them. this eliminates the stutter
  // caused by sendFrames() blocking the TTS consumer loop.
  function streamTtsToCall(text: string, call: ActiveCall, signal?: AbortSignal) {
    // normalize text for TTS: collapse newlines/paragraph breaks into
    // speech-friendly form so the TTS model generates audio for all content
    text = normalizeTextForTts(text)
    if (!text) return  // nothing to speak after normalization

    const enqueueTime = performance.now()

    call.ttsSending = call.ttsSending.then(async () => {
      if (signal?.aborted || !call.ws) return

      const chainWaitMs = performance.now() - enqueueTime
      if (chainWaitMs > 100) {
        log.warn('tts-chain', `waited ${chainWaitMs.toFixed(0)}ms for previous TTS to finish before "${text.slice(0, 40)}"`)
      }

      const t0 = performance.now()
      const callRate = call.mediaFormat?.sampleRate || 8000
      const callEnc = call.mediaFormat?.encoding || 'L16'
      const TTS_RATE = 24000

      const bps = callEnc === 'L16' ? 2 : 1
      // batch resampled PCM into ~120ms chunks before encoding+pushing.
      // this reduces per-chunk overhead while keeping latency low.
      const flushBytes = Math.ceil(callRate * 0.12) * bps
      let pending = Buffer.alloc(0)
      let totalPushedBytes = 0
      let chunkCount = 0
      let totalResampleMs = 0
      let maxPendingBytes = 0
      let lastChunkTime = t0
      let firstPushTime = 0

      // snapshot the queue generation so pushes are invalidated on cancel
      const gen = call.audioQueue.gen

      const flush = () => {
        if (pending.length === 0) return
        const encoded = fromPcm16(pending, callEnc)
        pending = Buffer.alloc(0)
        pushFrames(encoded, call, gen)
        if (!firstPushTime) firstPushTime = performance.now()
        totalPushedBytes += encoded.length
      }

      try {
        for await (const chunk of speakStreaming(text, getTtsOpts())) {
          if (signal?.aborted || gen !== call.audioQueue.gen) break
          chunkCount++
          const now = performance.now()
          const gapMs = now - lastChunkTime
          lastChunkTime = now

          const resampleStart = performance.now()
          const resampled = resamplePcm(chunk, TTS_RATE, callRate)
          totalResampleMs += performance.now() - resampleStart

          pending = Buffer.concat([pending, resampled])
          if (pending.length > maxPendingBytes) maxPendingBytes = pending.length

          if (gapMs > 500 && chunkCount > 1) {
            log.warn('tts-stream', `chunk#${chunkCount} gap=${gapMs.toFixed(0)}ms pending=${pending.length}B (stall in TTS generation?)`)
          }

          // push first chunk immediately for minimum TTFA, then batch
          if (chunkCount === 1 || pending.length >= flushBytes) flush()
        }
        if (!signal?.aborted && gen === call.audioQueue.gen) flush()
      } catch (e: any) {
        if (!signal?.aborted) log.err('tts', `stream error: ${e.message}`)
      }

      const elapsed = performance.now() - t0
      const audioMs = (totalPushedBytes / bps / callRate) * 1000
      const ttfp = firstPushTime ? (firstPushTime - t0).toFixed(0) : 'n/a'
      log.info('tts', `"${text.slice(0, 50)}${text.length > 50 ? '...' : ''}" → ${audioMs.toFixed(0)}ms audio, TTFP ${ttfp}ms, total ${elapsed.toFixed(0)}ms, ` +
        `chain_wait=${chainWaitMs.toFixed(0)}ms chunks=${chunkCount} resample=${totalResampleMs.toFixed(0)}ms maxPending=${maxPendingBytes}B queueDepth=${call.audioQueue.depth}`)
    }).catch(e => {
      if (!signal?.aborted) log.err('tts', `send chain error`, e)
    })
  }

  // ── barge-in: interrupt the agent response pipeline ──

  function interruptCall(call: ActiveCall, reason: string) {
    if (call.phase !== 'responding') return

    log.info('barge-in', `interrupting call ${call.callControlId}: ${reason} (queue depth=${call.audioQueue.depth})`)

    // abort the entire pipeline (LLM streaming + TTS)
    call.pipelineAbort?.abort()
    call.pipelineAbort = null

    // clear the audio queue. this bumps the generation counter, so any
    // in-flight TTS pushFrames() calls with the old generation are silently
    // dropped — no stale audio leaks into the next turn.
    call.audioQueue.clear()

    // flush any agent audio buffered on the Telnyx side by sending
    // a short burst of silence. this prevents the caller from hearing
    // the tail end of the agent's sentence smeared over their speech.
    clearCallAudio(call.callControlId)

    // reset the TTS chain so any pending .then() callbacks see a clean state
    // and new TTS calls don't queue behind an aborted chain
    call.ttsSending = Promise.resolve()

    // record what was spoken for context
    const spoken = call.spokenText.trim()
    call.phase = 'listening'
    call.textBuffer = ''
    call.spokenText = ''

    // if we had spoken text, add a note to the session about the interruption
    if (spoken) {
      const interruptNote = `[agent was interrupted after saying: "${spoken.slice(0, 200)}${spoken.length > 200 ? '...' : ''}"]`
      queueMessage(interruptNote, call.callControlId)
    }
  }

  // ── audio pipeline: VAD → transcribe → queue to agent ──

  async function processAudio(call: ActiveCall) {
    if (call.audioChunks.length === 0) return

    const chunks = call.audioChunks.splice(0)
    const audioBuffer = Buffer.concat(chunks)
    const sampleRate = call.mediaFormat?.sampleRate || 8000
    const encoding = call.mediaFormat?.encoding || 'L16'
    const bps = encoding === 'L16' ? 2 : 1
    const durationSec = audioBuffer.length / (sampleRate * bps)

    // skip very short audio
    if (durationSec < 0.5) {
      log.info('stt', `too short (${durationSec.toFixed(2)}s), skipping`)
      return
    }

    log.info('stt', `transcribing ${audioBuffer.length} bytes (${durationSec.toFixed(2)}s)`)

    try {
      // convert to PCM16 for WAV, upsample to 16kHz for whisper
      let pcm16 = toPcm16(audioBuffer, encoding)
      const wavRate = sampleRate < 16000 ? 16000 : sampleRate
      if (wavRate !== sampleRate) pcm16 = resamplePcm(pcm16, sampleRate, wavRate)
      const wav = buildWav(pcm16, wavRate)

      const text = await transcribe(wav)
      if (!text || !text.trim()) {
        log.info('stt', 'empty transcription')
        return
      }

      log.info('stt', `"${text}"`)
      queueMessage(`[phone call from ${call.from}]: ${text}`, call.callControlId)
    } catch (e) {
      log.err('stt', 'transcription failed', e)
    }
  }

  // ── message queue (channel plugin interface) ──

  function queueMessage(text: string, callControlId: string) {
    messageQueue.push({
      message: { role: 'user', content: [{ type: 'text', text }] },
      outputTarget: `telnyx-voice:${callControlId}`,
    })
    resolveWaiter?.()
    resolveWaiter = null
  }

  async function* inputGenerator() {
    while (true) {
      while (messageQueue.length > 0) {
        yield messageQueue.shift()!
      }
      await new Promise<void>(resolve => { resolveWaiter = resolve })
    }
  }

  // ── output handler: receives LLM streaming events ──
  // this is the key pipelining point. we accumulate text tokens, split into
  // sentences/paragraphs, and immediately stream each chunk to TTS as it completes.
  //
  // v2.1: on text_block_end, send remaining text as a single TTS call to avoid
  // per-sentence cold starts (~400ms each).
  //
  // v2.2: also split on paragraph breaks (\n\n) during streaming — this ensures
  // each paragraph gets its own TTS call, preventing the TTS model from truncating
  // at paragraph boundaries. text is normalized (newlines → spaces/periods) before
  // being sent to TTS.

  async function handleOutput(callControlId: string, message: ServerMessage) {
    // server's routeOutput strips the plugin name prefix, so we get just the callControlId
    const call = activeCalls.get(callControlId)
    if (!call) return

    if (message.type === 'text') {
      call.textBuffer += message.text

      // check if we have a complete sentence or paragraph to stream to TTS.
      // split points:
      //   1. sentence-ending punctuation followed by whitespace and a new word
      //   2. paragraph breaks (\n\n) — always a valid split point
      const buf = call.textBuffer

      // prefer paragraph break as split point (handles multi-paragraph responses)
      const paraBreak = buf.search(/\n\n+/)
      // also check for sentence boundary (punctuation + whitespace + new word)
      const sentenceEnd = buf.search(/[.!?;]\s+\S/)

      // pick the earliest valid split point
      let splitIdx = -1
      if (paraBreak >= 0 && (sentenceEnd < 0 || paraBreak <= sentenceEnd)) {
        // split at the paragraph break — take everything before \n\n
        splitIdx = paraBreak
      } else if (sentenceEnd >= 0) {
        // split after the sentence-ending punctuation
        splitIdx = sentenceEnd + 1
      }

      if (splitIdx >= 0) {
        // find the actual split: skip whitespace after the split point
        const afterWhitespace = buf.slice(splitIdx).search(/\S/)
        const splitAt = afterWhitespace >= 0 ? splitIdx + afterWhitespace : -1
        const sentence = (splitAt >= 0 ? buf.slice(0, splitAt) : buf).trim()
        call.textBuffer = splitAt >= 0 ? buf.slice(splitAt) : ''

        if (sentence) {
          call.phase = 'responding'
          if (!call.pipelineAbort) call.pipelineAbort = new AbortController()
          const signal = call.pipelineAbort.signal

          // process mixed text+DTMF
          const segments = parseResponseSegments(sentence)
          for (const seg of segments) {
            if (signal.aborted) break
            if (seg.type === 'text') {
              call.spokenText += seg.text + ' '
              streamTtsToCall(seg.text, call, signal)
            } else {
              // wait for pending TTS production + queue drain before sending DTMF
              await call.ttsSending
              await waitForQueueDrain(call)
              if (!signal.aborted) {
                await sendDtmf(call.callControlId, seg.digits).catch(e =>
                  log.err('dtmf', `send failed: ${e}`)
                )
              }
            }
          }
        }
      }
    } else if (message.type === 'text_block_end') {
      // flush remaining text
      const text = call.textBuffer.trim()
      call.textBuffer = ''
      if (text) {
        call.phase = 'responding'
        if (!call.pipelineAbort) call.pipelineAbort = new AbortController()
        const signal = call.pipelineAbort.signal

        const segments = parseResponseSegments(text)
        for (const seg of segments) {
          if (signal.aborted) break
          if (seg.type === 'text') {
            call.spokenText += seg.text + ' '
            streamTtsToCall(seg.text, call, signal)
          } else {
            await call.ttsSending
            await waitForQueueDrain(call)
            if (!signal.aborted) {
              await sendDtmf(call.callControlId, seg.digits).catch(e =>
                log.err('dtmf', `send failed: ${e}`)
              )
            }
          }
        }
      }
      // wait for TTS production to finish, then wait for the queue to drain
      // (caller hears everything), then go back to listening.
      call.ttsSending.then(() => waitForQueueDrain(call)).then(() => {
        if (call.phase === 'responding') {
          call.phase = 'listening'
          call.spokenText = ''
          call.pipelineAbort = null
        }
      })
    } else if (message.type === 'done') {
      // agent turn done — ensure we're back in listening state after queue drains
      call.ttsSending.then(() => waitForQueueDrain(call)).then(() => {
        if (call.phase === 'responding') {
          call.phase = 'listening'
          call.spokenText = ''
          call.pipelineAbort = null
        }
      })
    }
  }

  // ── webhook handler ──

  async function handleWebhook(event: TelnyxWebhookEvent) {
    const { event_type, payload } = event.data
    const callControlId = payload.call_control_id
    log.info('webhook', `${event_type} for ${callControlId}`)

    switch (event_type) {
      case 'call.initiated': {
        if (payload.direction === 'incoming') {
          log.info('webhook', `incoming call from ${payload.from} to ${payload.to}`)
          const call = makeCall(callControlId, payload.from, payload.to)
          initCallSession(call)
          await answerCall(callControlId)
        } else if (payload.direction === 'outgoing') {
          const call = activeCalls.get(callControlId)
          if (call && !call.sessionId) initCallSession(call)
        }
        break
      }

      case 'call.answered': {
        log.info('webhook', `call answered ${callControlId}`)
        ensureTtsServer()
        break
      }

      case 'call.hangup': {
        const call = activeCalls.get(callControlId)
        if (call) {
          queueMessage(`[phone call from ${call.from}]: [user hung up]`, callControlId)
          cleanupCall(call)
        }
        break
      }

      case 'call.machine.detection.ended': {
        const call = activeCalls.get(callControlId)
        if (call) cleanupCall(call)
        break
      }

      case 'call.dtmf.received': {
        const call = activeCalls.get(callControlId)
        if (call && payload.digit) {
          log.info('dtmf', `received from ${call.from}: ${payload.digit}`)
          queueMessage(`[DTMF from ${call.from}]: ${payload.digit}`, callControlId)
        }
        break
      }
    }
  }

  // ── media WebSocket handler ──

  function handleMediaWs(ws: ServerWebSocket<WsData>, raw: string) {
    let msg: TelnyxWsMessage
    try { msg = JSON.parse(raw) } catch { return }

    switch (msg.event) {
      case 'connected': {
        log.info('ws', `connected (v${msg.version})`)
        break
      }

      case 'start': {
        const { call_control_id, media_format } = msg.start
        const streamId = msg.stream_id
        log.info('ws', `stream start: call=${call_control_id} ${media_format.encoding}/${media_format.sample_rate}Hz`)

        ws.data.callControlId = call_control_id
        const call = activeCalls.get(call_control_id)
        if (!call) {
          log.warn('ws', `unknown call ${call_control_id}`)
          break
        }

        call.ws = ws
        call.streamId = streamId
        call.mediaFormat = {
          encoding: media_format.encoding,
          sampleRate: media_format.sample_rate,
          channels: media_format.channels,
        }
        streamToCall.set(streamId, call_control_id)
        initRecording(call)

        call.dtmfDetector = new DtmfDetector(media_format.sample_rate)

        // start the consumer timer — sends queued frames at 20ms pace
        startConsumer(call)

        // speak initial message for outbound calls
        if (call.initialMessage) {
          const msg = call.initialMessage
          call.initialMessage = null
          log.info('call', `speaking initial message: "${msg}"`)
          ensureTtsServer()
          // FIX: send initial message as one TTS call instead of splitting into sentences
          streamTtsToCall(msg, call)
        }
        break
      }

      case 'media': {
        const callControlId = ws.data.callControlId
        if (!callControlId) return
        const call = activeCalls.get(callControlId)
        if (!call) return

        const audioData = Buffer.from(msg.media.payload, 'base64')
        const now = Date.now()
        call.lastAudioTime = now

        // record inbound
        call.recording?.inbound.push(audioData)

        // DSP DTMF detection
        if (call.dtmfDetector) {
          const pcm16 = toPcm16(audioData, call.mediaFormat?.encoding || 'L16')
          for (const digit of call.dtmfDetector.process(pcm16)) {
            log.info('dtmf', `detected (DSP) from ${call.from}: ${digit}`)
            queueMessage(`[DTMF from ${call.from}]: ${digit}`, callControlId)
          }
        }

        // barge-in: if user speaks during agent response, interrupt
        if (call.phase === 'responding') {
          if (!detectSilence(call, audioData)) {
            interruptCall(call, 'user spoke during response')
          }
          // don't buffer audio during response (it's the agent speaking, not the user)
          break
        }

        // VAD: accumulate audio, detect silence to trigger transcription
        const isSilent = detectSilence(call, audioData)
        const silenceThreshold = config!.silenceThresholdMs || 700

        if (isSilent) {
          if (!call.silenceStart) call.silenceStart = now
          if (now - call.silenceStart >= silenceThreshold && call.audioChunks.length > 0) {
            call.silenceStart = null
            processAudio(call).catch(e => log.err('pipeline', 'error', e))
          }
        } else {
          call.silenceStart = null
          call.audioChunks.push(audioData)
        }
        break
      }

      case 'stop': {
        const callControlId = ws.data.callControlId
        if (!callControlId) break
        const call = activeCalls.get(callControlId)
        if (call && call.audioChunks.length > 0) {
          processAudio(call).catch(e => log.err('pipeline', 'error', e))
        }
        break
      }
    }
  }

  // ── outbound call ──

  async function createOutboundCall(to: string, initialMessage?: string): Promise<string> {
    if (!config!.connectionId) throw new Error('connectionId not configured')
    if (!config!.fromNumber) throw new Error('fromNumber not configured')
    if (!config!.publicHost) throw new Error('publicHost not configured')

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
    if (!res.ok) throw new Error(`telnyx API error ${res.status}: ${await res.text()}`)

    const body = await res.json() as { data: { call_control_id: string } }
    const callControlId = body.data.call_control_id
    log.info('call', `outbound call to ${to}, id=${callControlId}`)

    const call = makeCall(callControlId, config!.fromNumber!, to, initialMessage)
    initCallSession(call)
    return callControlId
  }

  // ── silence checker interval ──

  function startSilenceChecker() {
    silenceCheckInterval = setInterval(() => {
      const now = Date.now()
      const threshold = config!.silenceThresholdMs || 700
      for (const call of activeCalls.values()) {
        if (call.phase !== 'listening') continue
        if (call.audioChunks.length === 0) continue
        if (now - call.lastAudioTime >= threshold) {
          call.silenceStart = null
          processAudio(call).catch(e => log.err('pipeline', 'silence check error', e))
        }
      }
    }, 100)
  }

  // ── plugin interface ──

  const plugin: Plugin = {
    name: 'telnyx-voice',
    description: [
      'Real-time phone conversation via Telnyx voice API (streaming pipeline).',
      'User speech is transcribed and sent as messages prefixed with [phone call from <number>].',
      'Your text responses are streamed through TTS and played to the caller in real-time.',
      'Keep responses concise and conversational.',
      '\n\nDTMF: Embed [DTMF: digits] in your text to send tones. Valid: 0-9, *, #, A-D, w/W for pauses.',
      'When detecting DTMF from user, acknowledge but do NOT echo [DTMF:] markers back.',
    ].join(' '),

    tools: [
      {
        name: 'phone_call',
        description: 'Make an outbound phone call.',
        inputSchema: {
          type: 'object',
          properties: {
            to: { type: 'string', description: 'Phone number (E.164 format)' },
            purpose: { type: 'string', description: 'Why you are calling' },
            initialMessage: { type: 'string', description: 'Message to speak when call connects' },
          },
          required: ['to'],
        },
        async execute(input: unknown) {
          const { to, purpose, initialMessage } = input as { to: string; purpose?: string; initialMessage?: string }
          try {
            const id = await createOutboundCall(to, initialMessage)
            return { content: purpose ? `calling ${to} (${purpose}), id: ${id}` : `calling ${to}, id: ${id}` }
          } catch (e: any) {
            return { content: `failed: ${e.message}`, is_error: true }
          }
        },
      },
      {
        name: 'phone_hangup',
        description: 'Hang up an active phone call.',
        inputSchema: {
          type: 'object',
          properties: {
            call_id: { type: 'string', description: 'Call control ID (omit for most recent)' },
          },
        },
        async execute(input: unknown) {
          const { call_id } = input as { call_id?: string }
          const targetId = call_id || [...activeCalls.keys()].pop()
          if (!targetId || !activeCalls.has(targetId)) {
            return { content: 'no active call', is_error: true }
          }
          await hangupCall(targetId)
          return { content: `hanging up ${targetId}` }
        },
      },
      {
        name: 'send_dtmf',
        description: 'Send DTMF tones on an active call. Digits: 0-9, *, #, A-D, w/W for pauses.',
        inputSchema: {
          type: 'object',
          properties: {
            digits: { type: 'string', description: 'DTMF digits' },
            call_id: { type: 'string', description: 'Call control ID (omit for most recent)' },
            duration_ms: { type: 'number', description: 'Per-digit duration (100-500, default 250)' },
          },
          required: ['digits'],
        },
        async execute(input: unknown) {
          const { digits, call_id, duration_ms } = input as { digits: string; call_id?: string; duration_ms?: number }
          if (!/^[0-9A-D*#wW]+$/.test(digits)) {
            return { content: 'invalid DTMF digits', is_error: true }
          }
          const targetId = call_id || [...activeCalls.keys()].pop()
          if (!targetId || !activeCalls.has(targetId)) {
            return { content: 'no active call', is_error: true }
          }
          try {
            await sendDtmf(targetId, digits, duration_ms)
            return { content: `sent DTMF "${digits}"` }
          } catch (e: any) {
            return { content: `DTMF failed: ${e.message}`, is_error: true }
          }
        },
      },
      {
        name: 'phone_status',
        description: 'Get status of active phone calls.',
        inputSchema: { type: 'object', properties: {} },
        async execute() {
          if (activeCalls.size === 0) return { content: 'no active calls' }
          const lines = [...activeCalls.values()].map(c =>
            `- ${c.callControlId}: ${c.from} → ${c.to} (${c.phase}, session: ${c.sessionId})`
          )
          return { content: `active calls:\n${lines.join('\n')}` }
        },
      },
    ],

    input: inputGenerator(),
    output: handleOutput,

    async init(cfg: unknown) {
      config = cfg as Config
      if (!config?.apiKey) {
        log.warn('init', 'no API key configured')
        return
      }

      const webhookPort = config.webhookPort || 8091
      const mediaWsPort = config.mediaWsPort || 8092

      // pre-warm servers
      ensureWhisperServer().catch(e => log.err('init', 'whisper warmup failed', e))
      ensureTtsServer().catch(e => log.err('init', 'tts warmup failed', e))

      // webhook server
      webhookServer = Bun.serve({
        port: webhookPort,
        async fetch(req) {
          const url = new URL(req.url)
          if (url.pathname === '/health') return new Response('ok')
          if (req.method === 'POST' && (url.pathname === '/webhook' || url.pathname === '/')) {
            try {
              const body = await req.json() as TelnyxWebhookEvent
              handleWebhook(body).catch(e => log.err('webhook', 'handler error', e))
              return new Response('ok')
            } catch {
              return new Response('bad request', { status: 400 })
            }
          }
          return new Response('not found', { status: 404 })
        },
      })
      log.info('init', `webhook server on port ${webhookPort}`)

      // media WebSocket server
      mediaWsServer = Bun.serve<WsData>({
        port: mediaWsPort,
        fetch(req, server) {
          if (server.upgrade(req, { data: { callControlId: null } })) return undefined
          return new Response('WebSocket upgrade failed', { status: 500 })
        },
        websocket: {
          message(ws, data) {
            if (typeof data === 'string') handleMediaWs(ws, data)
          },
          close(ws) {
            const callControlId = ws.data.callControlId
            if (callControlId) {
              const call = activeCalls.get(callControlId)
              if (call) stopConsumer(call)
              log.info('ws', `closed for ${callControlId}`)
            }
          },
        },
      })
      log.info('init', `media ws server on port ${mediaWsPort}`)

      startSilenceChecker()
    },

    async destroy() {
      if (silenceCheckInterval) clearInterval(silenceCheckInterval)
      for (const call of activeCalls.values()) cleanupCall(call)
      webhookServer?.stop()
      mediaWsServer?.stop()
      log.info('destroy', 'plugin stopped')
    },
  }

  return plugin
}
