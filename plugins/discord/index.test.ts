import { describe, test, expect, beforeAll } from 'bun:test'
import { DISCORD_MAX_LENGTH, STREAM_EDIT_INTERVAL_MS, renderToolBatch, findBreakPoint, formatChannelContext, type ToolBatchEntry } from './index.ts'
import type { Plugin } from '../../server/plugin.ts'

describe('findBreakPoint', () => {
  test('returns full length when text fits', () => {
    expect(findBreakPoint('hello', 10)).toBe(5)
  })

  test('prefers double newline break', () => {
    const text = 'aaaaaaaaaa\n\nbbbbbbbbbb'
    // double newline is at index 10, maxLen = 15 → should break after \n\n (index 12)
    expect(findBreakPoint(text, 15)).toBe(12)
  })

  test('falls back to single newline', () => {
    const text = 'aaaaaaaaaa\nbbbbbbbbbb'
    expect(findBreakPoint(text, 15)).toBe(11)
  })

  test('falls back to space', () => {
    const text = 'aaaaaaaaaa bbbbbbbbbb'
    expect(findBreakPoint(text, 15)).toBe(11)
  })

  test('falls back to maxLen when no good break', () => {
    const text = 'aaaaaaaaaaaaaaaaaaaaa'
    expect(findBreakPoint(text, 10)).toBe(10)
  })
})

describe('renderToolBatch', () => {
  test('shows pending tools with spinner', () => {
    const batch: ToolBatchEntry[] = [
      { name: 'bash', summary: 'ls', inputTokens: 10 },
    ]
    const result = renderToolBatch(batch, false)
    expect(result).toContain('⏳ bash: ls')
    expect(result).toContain('0/1 done')
  })

  test('shows completed tools with checkmark', () => {
    const batch: ToolBatchEntry[] = [
      { name: 'bash', summary: 'ls', inputTokens: 10, resultTokens: 5 },
    ]
    const result = renderToolBatch(batch, true)
    expect(result).toContain('✅ bash: ls')
    expect(result).toContain('done — 1 tool')
  })

  test('shows error tools with X', () => {
    const batch: ToolBatchEntry[] = [
      { name: 'bash', summary: 'fail', inputTokens: 10, resultTokens: 5, isError: true },
    ]
    const result = renderToolBatch(batch, true)
    expect(result).toContain('❌ bash: fail')
    expect(result).toContain('1 failed')
  })

  test('truncates to 2000 chars', () => {
    const batch: ToolBatchEntry[] = Array.from({ length: 200 }, (_, i) => ({
      name: `tool_${i}`,
      summary: 'x'.repeat(50),
      inputTokens: 10,
    }))
    const result = renderToolBatch(batch, false)
    expect(result.length).toBeLessThanOrEqual(2000)
  })
})

describe('formatChannelContext', () => {
  test('guild channel includes channel name, guild name, channel ID, and author', () => {
    const result = formatChannelContext('123456789', 'alice', false, 'general', 'example-guild')
    expect(result).toBe('[#general in example-guild, channel 123456789, from alice]')
  })

  test('guild channel falls back to channel ID when channel name missing', () => {
    const result = formatChannelContext('123456789', 'alice', false, undefined, 'example-guild')
    expect(result).toBe('[#123456789 in example-guild, channel 123456789, from alice]')
  })

  test('guild channel falls back to unknown when guild name missing', () => {
    const result = formatChannelContext('123456789', 'alice', false, 'general')
    expect(result).toBe('[#general in unknown, channel 123456789, from alice]')
  })

  test('DM includes author and channel ID', () => {
    const result = formatChannelContext('987654321', 'alice', true)
    expect(result).toBe('[DM from alice, channel 987654321]')
  })
})

describe('discord plugin registration', () => {
  let plugin: Plugin

  beforeAll(async () => {
    // create() requires serverContext but doesn't fail without it
    const create = (await import('./index.ts')).default
    plugin = create()
  })

  test('exports expected tools', () => {
    const toolNames = plugin.tools!.map(t => t.name).sort()
    expect(toolNames).toContain('discord_send')
    expect(toolNames).toContain('discord_react')
  })

  test('has init and destroy lifecycle', () => {
    expect(plugin.init).toBeDefined()
    expect(plugin.destroy).toBeDefined()
  })
})

describe('constants', () => {
  test('max message length is 2000', () => {
    expect(DISCORD_MAX_LENGTH).toBe(2000)
  })

  test('stream edit interval is 2000ms', () => {
    expect(STREAM_EDIT_INTERVAL_MS).toBe(2000)
  })
})
