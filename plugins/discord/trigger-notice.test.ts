import { describe, test, expect } from 'bun:test'
import type { ServerMessage } from '../../server/types.ts'

describe('trigger_notice ServerMessage', () => {
  test('trigger_notice is a valid ServerMessage variant', () => {
    const msg: ServerMessage = {
      type: 'trigger_notice',
      source: 'timers',
      event: 'Timer fired: daily-08:00.md',
    }
    expect(msg.type).toBe('trigger_notice')
    expect(msg.source).toBe('timers')
    expect(msg.event).toBe('Timer fired: daily-08:00.md')
  })

  test('trigger_notice for coding agent completion', () => {
    const msg: ServerMessage = {
      type: 'trigger_notice',
      source: 'claude-code',
      event: 'Claude Code task completed successfully',
    }
    expect(msg.type).toBe('trigger_notice')
    expect(msg.source).toBe('claude-code')
    expect(msg.event).toContain('completed successfully')
  })

  test('trigger_notice for presence event', () => {
    const msg: ServerMessage = {
      type: 'trigger_notice',
      source: 'local-network-presence',
      event: "Jim's phone arrived",
    }
    expect(msg.type).toBe('trigger_notice')
    expect(msg.source).toBe('local-network-presence')
  })
})

describe('triggerEvent metadata on queued messages', () => {
  test('timers plugin metadata shape', () => {
    const metadata = {
      triggerEvent: { source: 'timers', event: 'Timer fired: daily-08:00.md' },
    }
    expect(metadata.triggerEvent.source).toBe('timers')
    expect(metadata.triggerEvent.event).toContain('Timer fired')
  })

  test('claude-code plugin metadata shape', () => {
    const metadata = {
      triggerEvent: { source: 'claude-code', event: 'Claude Code task completed successfully' },
    }
    expect(metadata.triggerEvent.source).toBe('claude-code')
    expect(metadata.triggerEvent.event).toContain('Claude Code')
  })

  test('gemini-cli plugin metadata shape', () => {
    const metadata = {
      triggerEvent: { source: 'gemini-cli', event: 'Gemini CLI task completed successfully' },
    }
    expect(metadata.triggerEvent.source).toBe('gemini-cli')
  })

  test('openai-codex plugin metadata shape', () => {
    const metadata = {
      triggerEvent: { source: 'openai-codex', event: 'Codex task completed successfully' },
    }
    expect(metadata.triggerEvent.source).toBe('openai-codex')
  })

  test('local-network-presence plugin metadata shape', () => {
    const metadata = {
      triggerEvent: { source: 'local-network-presence', event: "Jim's phone arrived" },
    }
    expect(metadata.triggerEvent.source).toBe('local-network-presence')
  })

  test('server extracts triggerEvent from metadata and constructs trigger_notice', () => {
    // simulate what server/index.ts does in the plugin input consumer
    const metadata: Record<string, unknown> = {
      triggerEvent: { source: 'timers', event: 'Timer fired: daily-08:00.md' },
    }
    const triggerEvent = metadata.triggerEvent as { source: string; event: string } | undefined

    expect(triggerEvent).toBeDefined()

    const serverMessage: ServerMessage = {
      type: 'trigger_notice',
      source: triggerEvent!.source,
      event: triggerEvent!.event,
    }
    expect(serverMessage.type).toBe('trigger_notice')
    expect(serverMessage.source).toBe('timers')
    expect(serverMessage.event).toBe('Timer fired: daily-08:00.md')
  })

  test('server skips trigger_notice when metadata has no triggerEvent', () => {
    const metadata: Record<string, unknown> = {
      discordMessageId: '123456',
    }
    const triggerEvent = metadata.triggerEvent as { source: string; event: string } | undefined
    expect(triggerEvent).toBeUndefined()
  })

  test('server skips trigger_notice when metadata is undefined', () => {
    const metadata = undefined
    const triggerEvent = metadata?.triggerEvent as { source: string; event: string } | undefined
    expect(triggerEvent).toBeUndefined()
  })

  test('discord renders trigger_notice as compact inline code', () => {
    // simulate what discord/index.ts does
    const message: ServerMessage & { type: 'trigger_notice' } = {
      type: 'trigger_notice',
      source: 'timers',
      event: 'Timer fired: daily-08:00.md',
    }
    const rendered = `\`⚡ ${message.event}\``
    expect(rendered).toBe('`⚡ Timer fired: daily-08:00.md`')
  })

  test('discord renders coding agent trigger_notice', () => {
    const message: ServerMessage & { type: 'trigger_notice' } = {
      type: 'trigger_notice',
      source: 'claude-code',
      event: 'Claude Code task completed successfully',
    }
    const rendered = `\`⚡ ${message.event}\``
    expect(rendered).toBe('`⚡ Claude Code task completed successfully`')
  })
})
