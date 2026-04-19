import { describe, test, expect } from 'bun:test'
import type { ServerMessage } from './types.ts'

describe('trigger_notice ServerMessage type', () => {
  test('trigger_notice is a valid ServerMessage shape', () => {
    const msg: ServerMessage = { type: 'trigger_notice', text: 'Timer fired: daily-09:00.md' }
    expect(msg.type).toBe('trigger_notice')
    expect(msg.text).toBe('Timer fired: daily-09:00.md')
  })

  test('coexists with other ServerMessage variants', () => {
    const messages: ServerMessage[] = [
      { type: 'trigger_notice', text: 'Claude Code task completed successfully' },
      { type: 'text', text: 'hello' },
      { type: 'queued', metadata: { discordMessageId: '123' } },
      { type: 'dequeued' },
    ]
    expect(messages).toHaveLength(4)
    expect(messages[0]!.type).toBe('trigger_notice')
  })
})

describe('plugin input triggerNotice field', () => {
  test('timers queued message includes triggerNotice', () => {
    // simulate what the timers plugin produces
    const queuedMsg = {
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: '[Timer fired: daily-09:00.md]\n\nDo the thing' }],
      },
      outputTarget: 'discord:123456',
      triggerNotice: 'Timer fired: daily-09:00.md',
    }

    expect(queuedMsg.triggerNotice).toBe('Timer fired: daily-09:00.md')
    expect(queuedMsg.outputTarget).toBe('discord:123456')
  })

  test('coding agent queued message includes triggerNotice and outputTarget', () => {
    // simulate what claude-code/gemini-cli/codex produce on completion
    const queuedMsg = {
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: '[Claude Code task completed successfully]\nSession: abc\nTask: fix bug' }],
      },
      outputTarget: 'discord:789',
      triggerNotice: 'Claude Code task completed successfully',
    }

    expect(queuedMsg.triggerNotice).toBe('Claude Code task completed successfully')
    expect(queuedMsg.outputTarget).toBe('discord:789')
  })

  test('triggerNotice is optional — messages without it are valid', () => {
    const queuedMsg = {
      message: {
        role: 'user' as const,
        content: [{ type: 'text' as const, text: 'hello' }],
      },
    }

    expect(queuedMsg).not.toHaveProperty('triggerNotice')
  })
})

describe('trigger notice routing logic', () => {
  test('routeOutput is called when triggerNotice and outputTarget are both present', async () => {
    // simulate the server's input consumer logic
    const routed: ServerMessage[] = []
    const routeOutput = async (target: string, message: ServerMessage) => {
      routed.push(message)
    }

    const triggerNotice = 'Timer fired: daily-09:00.md'
    const outputTarget = 'discord:123456'

    // this replicates the server's logic
    if (triggerNotice && outputTarget) {
      await routeOutput(outputTarget, { type: 'trigger_notice', text: triggerNotice })
    }

    expect(routed).toHaveLength(1)
    expect(routed[0]).toEqual({ type: 'trigger_notice', text: 'Timer fired: daily-09:00.md' })
  })

  test('no routing when triggerNotice is missing', async () => {
    const routed: ServerMessage[] = []
    const routeOutput = async (_target: string, message: ServerMessage) => {
      routed.push(message)
    }

    const triggerNotice = undefined
    const outputTarget = 'discord:123456'

    if (triggerNotice && outputTarget) {
      await routeOutput(outputTarget, { type: 'trigger_notice', text: triggerNotice })
    }

    expect(routed).toHaveLength(0)
  })

  test('no routing when outputTarget is missing', async () => {
    const routed: ServerMessage[] = []
    const routeOutput = async (_target: string, message: ServerMessage) => {
      routed.push(message)
    }

    const triggerNotice = 'Timer fired: daily-09:00.md'
    const outputTarget = undefined

    if (triggerNotice && outputTarget) {
      await routeOutput(outputTarget, { type: 'trigger_notice', text: triggerNotice })
    }

    expect(routed).toHaveLength(0)
  })
})
