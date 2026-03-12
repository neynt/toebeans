import { describe, test, expect } from 'bun:test'
import { findBreakPoint, DISCORD_MAX_LENGTH, STREAM_EDIT_INTERVAL_MS } from './index.ts'

describe('findBreakPoint', () => {
  test('returns text length when text fits within maxLen', () => {
    expect(findBreakPoint('hello world', 100)).toBe(11)
  })

  test('breaks at double newline when in second half', () => {
    const text = 'a'.repeat(1200) + '\n\n' + 'b'.repeat(900)
    expect(findBreakPoint(text, 2000)).toBe(1202) // after the \n\n
  })

  test('breaks at single newline when no double newline in second half', () => {
    const text = 'a'.repeat(1500) + '\n' + 'b'.repeat(600)
    expect(findBreakPoint(text, 2000)).toBe(1501) // after the \n
  })

  test('breaks at space when no newlines in second half', () => {
    const text = 'a'.repeat(1500) + ' ' + 'b'.repeat(600)
    expect(findBreakPoint(text, 2000)).toBe(1501) // after the space
  })

  test('hard breaks at maxLen when no good break point in second half', () => {
    const text = 'a'.repeat(2500) // no breaks at all
    expect(findBreakPoint(text, 2000)).toBe(2000)
  })

  test('prefers double newline over single newline', () => {
    const text = 'a'.repeat(1300) + '\n\n' + 'b'.repeat(200) + '\n' + 'c'.repeat(600)
    expect(findBreakPoint(text, 2000)).toBe(1302) // after the \n\n
  })

  test('ignores break points in first half (too early)', () => {
    // break point at position 400 is before 50% of 2000 = 1000
    const text = 'a'.repeat(400) + '\n\n' + 'b'.repeat(1700)
    expect(findBreakPoint(text, 2000)).toBe(2000) // falls through to hard break
  })

  test('handles exact maxLen', () => {
    const text = 'a'.repeat(2000)
    expect(findBreakPoint(text, 2000)).toBe(2000)
  })
})

describe('streaming output constants', () => {
  test('DISCORD_MAX_LENGTH is 2000', () => {
    expect(DISCORD_MAX_LENGTH).toBe(2000)
  })

  test('STREAM_EDIT_INTERVAL_MS is 1000', () => {
    expect(STREAM_EDIT_INTERVAL_MS).toBe(1000)
  })
})

// integration-style tests for the streaming behavior using mock Discord objects
describe('streaming output behavior', () => {
  // helper to create a mock discord plugin output pipeline
  function createMockOutput() {
    const sentMessages: Array<{ id: string; content: string; edits: string[] }> = []
    let nextId = 1

    const mockChannel = {
      send: async (content: string) => {
        const msg = { id: `msg_${nextId++}`, content, edits: [] as string[] }
        sentMessages.push(msg)
        return {
          id: msg.id,
          edit: async (newContent: string) => {
            msg.content = newContent
            msg.edits.push(newContent)
          },
        }
      },
      messages: {
        fetch: async (id: string) => {
          const msg = sentMessages.find(m => m.id === id)
          if (!msg) throw new Error(`message ${id} not found`)
          return {
            id: msg.id,
            edit: async (newContent: string) => {
              msg.content = newContent
              msg.edits.push(newContent)
            },
          }
        },
      },
      sendTyping: async () => {},
    }

    // simulate the streaming output logic from the plugin
    const messageBuffers = new Map<string, string>()
    const streamingMessages = new Map<string, { messageId: string; sentLength: number; lastEditTime: number }>()

    const flushStreamingBuffer = async (sessionId: string) => {
      let buffer = messageBuffers.get(sessionId) || ''
      const trimmed = buffer.trim()
      if (!trimmed) return

      const streaming = streamingMessages.get(sessionId)
      const now = Date.now()

      if (trimmed.length <= DISCORD_MAX_LENGTH) {
        if (streaming) {
          if (trimmed.length !== streaming.sentLength) {
            const msg = await mockChannel.messages.fetch(streaming.messageId)
            await msg.edit(trimmed)
            streaming.sentLength = trimmed.length
            streaming.lastEditTime = now
          }
        } else {
          const msg = await mockChannel.send(trimmed)
          streamingMessages.set(sessionId, { messageId: msg.id, sentLength: trimmed.length, lastEditTime: now })
        }
      } else {
        if (streaming) {
          const breakPoint = findBreakPoint(trimmed, DISCORD_MAX_LENGTH)
          const toKeep = trimmed.slice(0, breakPoint).trim()
          const remainder = trimmed.slice(breakPoint).trim()

          const msg = await mockChannel.messages.fetch(streaming.messageId)
          await msg.edit(toKeep.slice(0, DISCORD_MAX_LENGTH))
          streamingMessages.delete(sessionId)

          buffer = remainder
          messageBuffers.set(sessionId, buffer)
        }

        while (buffer.trim().length > DISCORD_MAX_LENGTH) {
          const breakPoint = findBreakPoint(buffer.trim(), DISCORD_MAX_LENGTH)
          const chunk = buffer.trim().slice(0, breakPoint).trim()
          buffer = buffer.trim().slice(breakPoint).trim()
          messageBuffers.set(sessionId, buffer)
          await mockChannel.send(chunk.slice(0, DISCORD_MAX_LENGTH))
        }

        if (buffer.trim()) {
          const msg = await mockChannel.send(buffer.trim().slice(0, DISCORD_MAX_LENGTH))
          streamingMessages.set(sessionId, { messageId: msg.id, sentLength: buffer.trim().length, lastEditTime: now })
        }
      }
    }

    const handleText = async (sessionId: string, text: string) => {
      let buffer = messageBuffers.get(sessionId) || ''
      buffer += text
      messageBuffers.set(sessionId, buffer)

      const streaming = streamingMessages.get(sessionId)

      if (buffer.trim().length > DISCORD_MAX_LENGTH) {
        await flushStreamingBuffer(sessionId)
      } else if (!streaming) {
        await flushStreamingBuffer(sessionId)
      } else if (Date.now() - streaming.lastEditTime >= STREAM_EDIT_INTERVAL_MS) {
        await flushStreamingBuffer(sessionId)
      }
    }

    const finalizeStreamingMessage = async (sessionId: string) => {
      const streaming = streamingMessages.get(sessionId)
      const buffer = messageBuffers.get(sessionId) || ''
      if (streaming && buffer.trim()) {
        const msg = await mockChannel.messages.fetch(streaming.messageId)
        await msg.edit(buffer.trim().slice(0, DISCORD_MAX_LENGTH))
      }
      streamingMessages.delete(sessionId)
      messageBuffers.delete(sessionId)
    }

    return { sentMessages, handleText, finalizeStreamingMessage, flushStreamingBuffer, messageBuffers, streamingMessages }
  }

  test('short response produces a single message that gets edited', async () => {
    const { sentMessages, handleText, finalizeStreamingMessage } = createMockOutput()
    const sid = 'test-session'

    await handleText(sid, 'Hello ')
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]!.content).toBe('Hello')

    await handleText(sid, 'world!\n\nSecond paragraph.')
    // should still be 1 message — no splitting on \n\n
    // (might not edit yet due to throttle, but finalize will)
    await finalizeStreamingMessage(sid)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]!.content).toBe('Hello world!\n\nSecond paragraph.')
  })

  test('multi-paragraph response stays as single message', async () => {
    const { sentMessages, handleText, finalizeStreamingMessage } = createMockOutput()
    const sid = 'test-session'

    await handleText(sid, 'Paragraph one.\n\n')
    await handleText(sid, 'Paragraph two.\n\n')
    await handleText(sid, 'Paragraph three.')
    await finalizeStreamingMessage(sid)

    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]!.content).toBe('Paragraph one.\n\nParagraph two.\n\nParagraph three.')
  })

  test('response exceeding 2000 chars gets split into multiple messages', async () => {
    const { sentMessages, handleText, finalizeStreamingMessage } = createMockOutput()
    const sid = 'test-session'

    // send a 3000 char response
    const longText = 'a'.repeat(1500) + '\n\n' + 'b'.repeat(1500)
    await handleText(sid, longText)
    await finalizeStreamingMessage(sid)

    // should be split into 2 messages
    expect(sentMessages.length).toBeGreaterThanOrEqual(2)
    // all content should be preserved
    const totalContent = sentMessages.map(m => m.content).join('')
    // just check the chars are all there (trimming may remove some whitespace)
    expect(totalContent.replace(/\s/g, '').length).toBe(3000)
  })

  test('first text chunk creates message immediately', async () => {
    const { sentMessages, handleText } = createMockOutput()
    const sid = 'test-session'

    await handleText(sid, 'Hi')
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]!.content).toBe('Hi')
  })

  test('subsequent chunks within 1s are buffered (not edited immediately)', async () => {
    const { sentMessages, handleText } = createMockOutput()
    const sid = 'test-session'

    await handleText(sid, 'Hello ')
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]!.edits).toHaveLength(0)

    // second chunk within 1s — should NOT trigger edit
    await handleText(sid, 'world')
    expect(sentMessages[0]!.edits).toHaveLength(0) // not edited yet
  })

  test('finalize edits message with complete content', async () => {
    const { sentMessages, handleText, finalizeStreamingMessage } = createMockOutput()
    const sid = 'test-session'

    await handleText(sid, 'part one ')
    await handleText(sid, 'part two ')
    await handleText(sid, 'part three')

    await finalizeStreamingMessage(sid)
    expect(sentMessages).toHaveLength(1)
    expect(sentMessages[0]!.content).toBe('part one part two part three')
    expect(sentMessages[0]!.edits.length).toBeGreaterThanOrEqual(1)
  })
})
