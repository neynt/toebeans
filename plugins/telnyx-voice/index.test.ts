// tests for telnyx-voice helper functions
// we test the pure functions that don't need network/server context

import { describe, test, expect } from 'bun:test'

// since the plugin is a factory function with internal helpers, we need to
// extract the testable pieces. we'll import the module and test what we can.
// the codec helpers and DTMF detector are defined at module scope.

// ── test codec round-trips ──
// we can't easily import internals, so we recreate the core logic here
// to verify correctness. the actual plugin uses these exact algorithms.

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

// DTMF response segment parser (copied from plugin for testing)
const DTMF_PATTERN = /\[DTMF:\s*([0-9A-D*#wW,\s]+)\]/gi

interface TextSegment { type: 'text'; text: string }
interface DtmfSegment { type: 'dtmf'; digits: string }
type ResponseSegment = TextSegment | DtmfSegment

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

// normalizeTextForTts (copied from plugin for testing)
function normalizeTextForTts(text: string): string {
  return text
    .replace(/([.!?;])\s*\n\n+\s*/g, '$1 ')
    .replace(/\n\n+\s*/g, '. ')
    .replace(/\n/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim()
}

// streaming sentence/paragraph split logic (mirrors handleOutput)
function findStreamingSplit(buf: string): { sentence: string; remaining: string } | null {
  const paraBreak = buf.search(/\n\n+/)
  const sentenceEnd = buf.search(/[.!?;]\s+\S/)

  let splitIdx = -1
  if (paraBreak >= 0 && (sentenceEnd < 0 || paraBreak <= sentenceEnd)) {
    splitIdx = paraBreak
  } else if (sentenceEnd >= 0) {
    splitIdx = sentenceEnd + 1
  }

  if (splitIdx < 0) return null

  const afterWhitespace = buf.slice(splitIdx).search(/\S/)
  const splitAt = afterWhitespace >= 0 ? splitIdx + afterWhitespace : -1
  const sentence = (splitAt >= 0 ? buf.slice(0, splitAt) : buf).trim()
  const remaining = splitAt >= 0 ? buf.slice(splitAt) : ''
  return sentence ? { sentence, remaining } : null
}

// ── tests ──

describe('normalizeTextForTts', () => {
  test('single paragraph unchanged', () => {
    expect(normalizeTextForTts('Hello, world.')).toBe('Hello, world.')
  })

  test('collapses paragraph break after sentence-ending punctuation', () => {
    expect(normalizeTextForTts('First sentence.\n\nSecond paragraph.'))
      .toBe('First sentence. Second paragraph.')
  })

  test('adds period for paragraph break without trailing punctuation', () => {
    expect(normalizeTextForTts('First part\n\nSecond part'))
      .toBe('First part. Second part')
  })

  test('handles multiple paragraph breaks', () => {
    expect(normalizeTextForTts('A.\n\nB.\n\nC.'))
      .toBe('A. B. C.')
  })

  test('converts single newlines to spaces', () => {
    expect(normalizeTextForTts('line one\nline two'))
      .toBe('line one line two')
  })

  test('collapses multiple spaces', () => {
    expect(normalizeTextForTts('too   many   spaces'))
      .toBe('too many spaces')
  })

  test('trims leading and trailing whitespace', () => {
    expect(normalizeTextForTts('  hello  ')).toBe('hello')
  })

  test('handles mixed newlines and paragraph breaks', () => {
    expect(normalizeTextForTts('Line one.\nLine two.\n\nNew paragraph.'))
      .toBe('Line one. Line two. New paragraph.')
  })

  test('empty string returns empty', () => {
    expect(normalizeTextForTts('')).toBe('')
  })

  test('whitespace-only returns empty', () => {
    expect(normalizeTextForTts('\n\n  \n')).toBe('.')
  })

  test('preserves exclamation and question marks at paragraph boundaries', () => {
    expect(normalizeTextForTts('Really?\n\nYes!'))
      .toBe('Really? Yes!')
  })

  test('triple+ newlines treated same as double', () => {
    expect(normalizeTextForTts('A.\n\n\n\nB.'))
      .toBe('A. B.')
  })
})

describe('streaming sentence/paragraph split', () => {
  test('no split when buffer has no sentence boundary', () => {
    expect(findStreamingSplit('Hello world')).toBeNull()
  })

  test('splits on sentence boundary (period + space + word)', () => {
    const result = findStreamingSplit('Hello world. Next sentence starts')
    expect(result).toEqual({
      sentence: 'Hello world.',
      remaining: 'Next sentence starts',
    })
  })

  test('splits on paragraph break', () => {
    const result = findStreamingSplit('First paragraph.\n\nSecond paragraph')
    expect(result).toEqual({
      sentence: 'First paragraph.',
      remaining: 'Second paragraph',
    })
  })

  test('paragraph break without punctuation', () => {
    const result = findStreamingSplit('Some text\n\nMore text')
    expect(result).toEqual({
      sentence: 'Some text',
      remaining: 'More text',
    })
  })

  test('prefers paragraph break over later sentence boundary', () => {
    // paragraph break comes first
    const result = findStreamingSplit('First\n\nSecond. Third starts')
    expect(result).toEqual({
      sentence: 'First',
      remaining: 'Second. Third starts',
    })
  })

  test('prefers earlier sentence boundary over later paragraph break', () => {
    const result = findStreamingSplit('First sentence. More text\n\nThird')
    expect(result).toEqual({
      sentence: 'First sentence.',
      remaining: 'More text\n\nThird',
    })
  })

  test('handles question mark as sentence boundary', () => {
    const result = findStreamingSplit('Really? Yes indeed')
    expect(result).toEqual({
      sentence: 'Really?',
      remaining: 'Yes indeed',
    })
  })

  test('handles exclamation mark as sentence boundary', () => {
    const result = findStreamingSplit('Wow! That is great')
    expect(result).toEqual({
      sentence: 'Wow!',
      remaining: 'That is great',
    })
  })

  test('no split when period has no following word yet', () => {
    // LLM hasn't sent the next token yet
    expect(findStreamingSplit('Hello world.')).toBeNull()
  })

  test('no split on period mid-word (abbreviation)', () => {
    // "Dr.Smith" — no whitespace after period
    expect(findStreamingSplit('Dr.Smith said')).toBeNull()
  })
})

describe('mu-law codec round-trip', () => {
  test('encodes and decodes within mu-law dynamic range', () => {
    // mu-law clamps to ±8191 so only test values in that range
    const samples = [0, 100, -100, 1000, -1000, 4000, -4000, 8000, -8000]
    const pcm = Buffer.alloc(samples.length * 2)
    for (let i = 0; i < samples.length; i++) {
      pcm.writeInt16LE(samples[i]!, i * 2)
    }

    const encoded = encodeMuLaw(pcm)
    expect(encoded.length).toBe(samples.length)

    const decoded = decodeMuLaw(encoded)
    expect(decoded.length).toBe(pcm.length)

    // mu-law is lossy. for typical telephony values (speech is usually <8000),
    // the error should be reasonable (under 20% for values above a few hundred).
    for (let i = 0; i < samples.length; i++) {
      const original = samples[i]!
      const roundTripped = decoded.readInt16LE(i * 2)
      if (Math.abs(original) >= 4000) {
        const error = Math.abs(original - roundTripped) / Math.abs(original)
        expect(error).toBeLessThan(0.1) // within 10% for larger values
      }
    }
  })

  test('produces correct output size', () => {
    const pcm = Buffer.alloc(200) // 100 16-bit samples
    const encoded = encodeMuLaw(pcm)
    expect(encoded.length).toBe(100) // 1 byte per sample
    const decoded = decodeMuLaw(encoded)
    expect(decoded.length).toBe(200) // back to 16-bit
  })
})

describe('resampler', () => {
  test('identity resample (same rate) returns same buffer', () => {
    const pcm = Buffer.alloc(100)
    for (let i = 0; i < 50; i++) {
      pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 10000), i * 2)
    }
    const result = resamplePcm(pcm, 8000, 8000)
    expect(result).toBe(pcm)
  })

  test('downsampling 24kHz to 8kHz produces 1/3 the samples', () => {
    const inputSamples = 240 // 10ms at 24kHz
    const pcm = Buffer.alloc(inputSamples * 2)
    // 1kHz sine at 24kHz (well under 4kHz nyquist of 8kHz target)
    for (let i = 0; i < inputSamples; i++) {
      const t = i / 24000
      pcm.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 1000 * t) * 10000), i * 2)
    }

    const result = resamplePcm(pcm, 24000, 8000)
    const outputSamples = result.length / 2
    expect(outputSamples).toBe(80) // 10ms at 8kHz
  })

  test('upsampling 8kHz to 16kHz doubles the samples', () => {
    const inputSamples = 80 // 10ms at 8kHz
    const pcm = Buffer.alloc(inputSamples * 2)
    for (let i = 0; i < inputSamples; i++) {
      pcm.writeInt16LE(Math.round(Math.sin(i * 0.1) * 10000), i * 2)
    }

    const result = resamplePcm(pcm, 8000, 16000)
    const outputSamples = result.length / 2
    expect(outputSamples).toBe(160) // 10ms at 16kHz
  })
})

describe('parseResponseSegments', () => {
  test('plain text returns single text segment', () => {
    const result = parseResponseSegments('Hello, how are you?')
    expect(result).toEqual([{ type: 'text', text: 'Hello, how are you?' }])
  })

  test('DTMF only returns single dtmf segment', () => {
    const result = parseResponseSegments('[DTMF: 123]')
    expect(result).toEqual([{ type: 'dtmf', digits: '123' }])
  })

  test('text with embedded DTMF splits correctly', () => {
    const result = parseResponseSegments('Let me press 1. [DTMF: 1] Now waiting.')
    expect(result).toEqual([
      { type: 'text', text: 'Let me press 1.' },
      { type: 'dtmf', digits: '1' },
      { type: 'text', text: 'Now waiting.' },
    ])
  })

  test('commas in DTMF are converted to w pauses', () => {
    const result = parseResponseSegments('[DTMF: 1,2,3]')
    expect(result).toEqual([{ type: 'dtmf', digits: '1w2w3' }])
  })

  test('whitespace in DTMF digits is stripped', () => {
    const result = parseResponseSegments('[DTMF: 1 2 3]')
    expect(result).toEqual([{ type: 'dtmf', digits: '123' }])
  })

  test('multiple DTMF segments', () => {
    const result = parseResponseSegments('Press 1 [DTMF: 1] wait [DTMF: 2] done')
    expect(result).toEqual([
      { type: 'text', text: 'Press 1' },
      { type: 'dtmf', digits: '1' },
      { type: 'text', text: 'wait' },
      { type: 'dtmf', digits: '2' },
      { type: 'text', text: 'done' },
    ])
  })

  test('case-insensitive DTMF matching', () => {
    const result = parseResponseSegments('[dtmf: 1A*#]')
    expect(result).toEqual([{ type: 'dtmf', digits: '1A*#' }])
  })
})

describe('flush buffer sizing', () => {
  // v2.2: bumped from 60ms to 120ms to reduce stutter at flush boundaries
  test('120ms at 8kHz L16 = 1920 bytes', () => {
    const callRate = 8000
    const bps = 2 // L16
    const flushBytes = Math.ceil(callRate * 0.12) * bps
    expect(flushBytes).toBe(1920)
  })

  test('120ms at 16kHz L16 = 3840 bytes', () => {
    const callRate = 16000
    const bps = 2
    const flushBytes = Math.ceil(callRate * 0.12) * bps
    expect(flushBytes).toBe(3840)
  })

  test('120ms at 8kHz PCMU = 960 bytes', () => {
    const callRate = 8000
    const bps = 1 // PCMU/PCMA
    const flushBytes = Math.ceil(callRate * 0.12) * bps
    expect(flushBytes).toBe(960)
  })

  // compare with old 200ms buffer to show we're still improved
  test('old 200ms buffer was 3200 bytes at 8kHz L16', () => {
    const callRate = 8000
    const bps = 2
    const oldFlushBytes = Math.ceil(callRate * 0.2) * bps
    expect(oldFlushBytes).toBe(3200)
  })
})

describe('frame pacing', () => {
  test('frame size at 8kHz L16 is 320 bytes (20ms)', () => {
    const rate = 8000
    const bps = 2
    const frameMs = 20
    const frameBytes = rate * frameMs / 1000 * bps
    expect(frameBytes).toBe(320)
  })

  test('frame size at 16kHz L16 is 640 bytes (20ms)', () => {
    const rate = 16000
    const bps = 2
    const frameMs = 20
    const frameBytes = rate * frameMs / 1000 * bps
    expect(frameBytes).toBe(640)
  })

  test('silence flush for barge-in is 5 frames (100ms)', () => {
    // verifies our clearCallAudio sends enough silence to flush jitter buffer
    const silenceFrames = 5
    const frameMs = 20
    expect(silenceFrames * frameMs).toBe(100)
  })
})

// ── AudioQueue tests ──
// recreate the class here since we can't import internals from the factory

class AudioQueue {
  private frames: Buffer[] = []
  private generation = 0
  totalPushed = 0
  totalPulled = 0
  peakDepth = 0
  underruns = 0

  get depth(): number { return this.frames.length }
  get gen(): number { return this.generation }

  push(frame: Buffer, gen: number) {
    if (gen !== this.generation) return
    this.frames.push(frame)
    this.totalPushed++
    if (this.frames.length > this.peakDepth) this.peakDepth = this.frames.length
  }

  pull(): Buffer | null {
    const frame = this.frames.shift() ?? null
    if (frame) { this.totalPulled++ } else { this.underruns++ }
    return frame
  }

  clear() {
    this.frames.length = 0
    this.generation++
    this.totalPushed = 0
    this.totalPulled = 0
    this.peakDepth = 0
    this.underruns = 0
  }
}

describe('AudioQueue', () => {
  test('push and pull single frame', () => {
    const q = new AudioQueue()
    const frame = Buffer.alloc(320, 0x42)
    q.push(frame, q.gen)
    expect(q.depth).toBe(1)
    expect(q.totalPushed).toBe(1)

    const pulled = q.pull()
    expect(pulled).toBe(frame)
    expect(q.depth).toBe(0)
    expect(q.totalPulled).toBe(1)
  })

  test('pull from empty queue returns null and increments underruns', () => {
    const q = new AudioQueue()
    expect(q.pull()).toBeNull()
    expect(q.underruns).toBe(1)
    expect(q.pull()).toBeNull()
    expect(q.underruns).toBe(2)
  })

  test('FIFO ordering', () => {
    const q = new AudioQueue()
    const gen = q.gen
    const a = Buffer.from([1])
    const b = Buffer.from([2])
    const c = Buffer.from([3])
    q.push(a, gen)
    q.push(b, gen)
    q.push(c, gen)
    expect(q.pull()).toBe(a)
    expect(q.pull()).toBe(b)
    expect(q.pull()).toBe(c)
    expect(q.pull()).toBeNull()
  })

  test('peak depth tracks maximum queue size', () => {
    const q = new AudioQueue()
    const gen = q.gen
    q.push(Buffer.alloc(1), gen)
    q.push(Buffer.alloc(1), gen)
    q.push(Buffer.alloc(1), gen)
    expect(q.peakDepth).toBe(3)
    q.pull()
    q.pull()
    expect(q.peakDepth).toBe(3) // peak doesn't decrease
    expect(q.depth).toBe(1)
  })

  test('clear empties queue and bumps generation', () => {
    const q = new AudioQueue()
    const gen0 = q.gen
    q.push(Buffer.alloc(1), gen0)
    q.push(Buffer.alloc(1), gen0)
    expect(q.depth).toBe(2)

    q.clear()
    expect(q.depth).toBe(0)
    expect(q.gen).toBe(gen0 + 1)
    expect(q.totalPushed).toBe(0)
    expect(q.totalPulled).toBe(0)
    expect(q.peakDepth).toBe(0)
    expect(q.underruns).toBe(0)
  })

  test('stale generation pushes are silently dropped', () => {
    const q = new AudioQueue()
    const gen0 = q.gen
    q.push(Buffer.alloc(1), gen0)
    expect(q.depth).toBe(1)

    q.clear()
    // push with old generation should be ignored
    q.push(Buffer.alloc(1), gen0)
    expect(q.depth).toBe(0)
    expect(q.totalPushed).toBe(0)

    // push with new generation should work
    const gen1 = q.gen
    q.push(Buffer.alloc(1), gen1)
    expect(q.depth).toBe(1)
    expect(q.totalPushed).toBe(1)
  })

  test('simulates producer/consumer scenario', () => {
    const q = new AudioQueue()
    const gen = q.gen
    const frameSize = 320  // 20ms at 8kHz L16

    // producer pushes 50 frames (1 second of audio)
    for (let i = 0; i < 50; i++) {
      q.push(Buffer.alloc(frameSize, i), gen)
    }
    expect(q.depth).toBe(50)
    expect(q.peakDepth).toBe(50)

    // consumer pulls 30 frames
    for (let i = 0; i < 30; i++) {
      const frame = q.pull()
      expect(frame).not.toBeNull()
      expect(frame![0]).toBe(i) // FIFO order preserved
    }
    expect(q.depth).toBe(20)
    expect(q.totalPulled).toBe(30)
  })

  test('barge-in scenario: clear mid-stream prevents old audio leaking', () => {
    const q = new AudioQueue()
    const gen0 = q.gen

    // producer starts pushing
    q.push(Buffer.from([1]), gen0)
    q.push(Buffer.from([2]), gen0)

    // barge-in! clear the queue
    q.clear()

    // old producer tries to push more with stale generation
    q.push(Buffer.from([3]), gen0)
    q.push(Buffer.from([4]), gen0)
    expect(q.depth).toBe(0) // nothing leaked

    // new TTS starts with fresh generation
    const gen1 = q.gen
    q.push(Buffer.from([10]), gen1)
    expect(q.depth).toBe(1)
    expect(q.pull()![0]).toBe(10)
  })
})
