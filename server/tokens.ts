import type { ToolResultContent, ContentBlock, ImageSource, Message } from './types.ts'

/**
 * Estimate token count from text. Uses a simple heuristic (~4 chars/token)
 * that works reasonably well across tokenizers. The anthropic tokenizer
 * could be used for exact counts, but this keeps us provider-agnostic.
 */
export function countTokens(text: string): number {
  // ~4 chars per token is a decent cross-model estimate
  return Math.ceil(text.length / 4)
}

/**
 * Estimate image tokens using Anthropic's formula: (width * height) / 750
 * Decodes dimensions from PNG/JPEG/GIF/WebP headers in base64 data.
 * Falls back to a conservative estimate if we can't parse dimensions.
 */
export function estimateImageTokens(source: ImageSource): number {
  if (source.type === 'url') {
    // can't determine dimensions from URL alone; use conservative estimate
    return 1000
  }

  const dims = getImageDimensions(source.data, source.media_type)
  if (!dims) {
    // fallback: assume a typical 1024x768 image
    return Math.ceil((1024 * 768) / 750)
  }

  return Math.ceil((dims.width * dims.height) / 750)
}

function getImageDimensions(
  base64Data: string,
  mediaType: string
): { width: number; height: number } | null {
  // decode enough of the header to get dimensions
  // PNG: dimensions at bytes 16-23 in IHDR
  // JPEG: need to scan for SOF marker
  // GIF: dimensions at bytes 6-9
  // WebP: dimensions at bytes 26-29 (for VP8)

  try {
    if (mediaType === 'image/png') {
      return getPngDimensions(base64Data)
    } else if (mediaType === 'image/jpeg') {
      return getJpegDimensions(base64Data)
    } else if (mediaType === 'image/gif') {
      return getGifDimensions(base64Data)
    } else if (mediaType === 'image/webp') {
      return getWebpDimensions(base64Data)
    }
  } catch {
    // parsing failed
  }
  return null
}

function decodeBase64Slice(base64Data: string, maxBytes: number): Buffer {
  // only decode enough base64 chars to get maxBytes of binary data
  // each 4 base64 chars = 3 bytes
  const charsNeeded = Math.ceil(maxBytes / 3) * 4
  const slice = base64Data.slice(0, charsNeeded)
  return Buffer.from(slice, 'base64')
}

function getPngDimensions(base64Data: string): { width: number; height: number } | null {
  // PNG IHDR: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
  const buf = decodeBase64Slice(base64Data, 24)
  if (buf.length < 24) return null
  // verify PNG signature
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return null
  const width = buf.readUInt32BE(16)
  const height = buf.readUInt32BE(20)
  return { width, height }
}

function getJpegDimensions(base64Data: string): { width: number; height: number } | null {
  // JPEG: scan for SOF0 (0xFFC0) or SOF2 (0xFFC2) marker
  // decode a larger chunk since SOF can be anywhere in the header
  const buf = decodeBase64Slice(base64Data, 65536)
  if (buf.length < 4) return null
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return null // not JPEG

  let offset = 2
  while (offset < buf.length - 9) {
    if (buf[offset] !== 0xff) {
      offset++
      continue
    }
    const marker = buf[offset + 1]!
    // SOF markers: 0xC0-0xC3, 0xC5-0xC7, 0xC9-0xCB, 0xCD-0xCF
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      const height = buf.readUInt16BE(offset + 5)
      const width = buf.readUInt16BE(offset + 7)
      return { width, height }
    }
    // skip to next marker using segment length
    if (offset + 3 < buf.length) {
      const segmentLength = buf.readUInt16BE(offset + 2)
      offset += 2 + segmentLength
    } else {
      break
    }
  }
  return null
}

function getGifDimensions(base64Data: string): { width: number; height: number } | null {
  // GIF: width at offset 6 (2 bytes LE), height at offset 8 (2 bytes LE)
  const buf = decodeBase64Slice(base64Data, 10)
  if (buf.length < 10) return null
  // verify GIF signature
  const sig = buf.toString('ascii', 0, 3)
  if (sig !== 'GIF') return null
  const width = buf.readUInt16LE(6)
  const height = buf.readUInt16LE(8)
  return { width, height }
}

function getWebpDimensions(base64Data: string): { width: number; height: number } | null {
  // WebP: RIFF header, then VP8/VP8L/VP8X chunk
  const buf = decodeBase64Slice(base64Data, 30)
  if (buf.length < 30) return null
  // verify RIFF and WEBP
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return null

  const chunk = buf.toString('ascii', 12, 16)
  if (chunk === 'VP8 ') {
    // lossy: width at 26, height at 28 (LE, 16-bit, low 14 bits)
    const width = buf.readUInt16LE(26) & 0x3fff
    const height = buf.readUInt16LE(28) & 0x3fff
    return { width, height }
  } else if (chunk === 'VP8L') {
    // lossless: dimensions packed in 4 bytes at offset 21
    const bits = buf.readUInt32LE(21)
    const width = (bits & 0x3fff) + 1
    const height = ((bits >> 14) & 0x3fff) + 1
    return { width, height }
  } else if (chunk === 'VP8X') {
    // extended: width at 24 (3 bytes LE + 1), height at 27 (3 bytes LE + 1)
    const width = (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1
    const height = (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1
    return { width, height }
  }
  return null
}

/**
 * Count tokens for a ToolResultContent, handling image blocks correctly.
 */
export function countToolResultTokens(content: ToolResultContent): number {
  if (typeof content === 'string') return countTokens(content)

  let total = 0
  for (const block of content) {
    if (block.type === 'text') {
      total += countTokens(block.text)
    } else if (block.type === 'image') {
      total += estimateImageTokens(block.source)
    }
  }
  return total
}

/**
 * Count tokens for a ContentBlock array, handling images correctly.
 */
export function countContentTokens(content: ContentBlock[]): number {
  let total = 0
  for (const block of content) {
    if (block.type === 'text') {
      total += countTokens(block.text)
    } else if (block.type === 'image') {
      total += estimateImageTokens(block.source)
    } else if (block.type === 'tool_use') {
      const inputStr = typeof block.input === 'string'
        ? block.input
        : JSON.stringify(block.input)
      total += countTokens(block.name + inputStr)
    } else if (block.type === 'tool_result') {
      total += countToolResultTokens(block.content)
    }
  }
  return total
}

/**
 * Count tokens for a full message list, handling images correctly.
 */
export function countMessagesTokens(messages: Message[]): number {
  let total = 0
  for (const msg of messages) {
    total += countContentTokens(msg.content)
  }
  return total
}
