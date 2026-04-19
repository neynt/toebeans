import { describe, it, expect } from 'bun:test'
import { shouldAutoResume, getInterruptedTurnResumeContent } from './auto-resume.ts'
import type { Message } from './types.ts'
import type { ActiveTurnState } from './session.ts'

function assistantWithToolUse(toolName: string): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'doing something' },
      { type: 'tool_use', id: 'call_1', name: toolName, input: {} },
    ],
  }
}

function toolResult(toolUseId: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }],
  }
}

describe('shouldAutoResume', () => {
  it('returns true when last assistant message called restart_server', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      assistantWithToolUse('restart_server'),
      toolResult('call_1'),
    ]
    expect(shouldAutoResume(messages)).toBe(true)
  })

  it('returns true when last assistant message called enable_plugin', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'enable foo' }] },
      assistantWithToolUse('enable_plugin'),
      toolResult('call_1'),
    ]
    expect(shouldAutoResume(messages)).toBe(true)
  })

  it('returns true when last assistant message called disable_plugin', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'disable foo' }] },
      assistantWithToolUse('disable_plugin'),
      toolResult('call_1'),
    ]
    expect(shouldAutoResume(messages)).toBe(true)
  })

  it('returns false when last assistant message used a different tool', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'search' }] },
      assistantWithToolUse('web_search'),
      toolResult('call_1'),
    ]
    expect(shouldAutoResume(messages)).toBe(false)
  })

  it('returns false when last assistant message has only text', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]
    expect(shouldAutoResume(messages)).toBe(false)
  })

  it('returns false for empty messages', () => {
    expect(shouldAutoResume([])).toBe(false)
  })

  it('ignores earlier assistant messages with restart_server', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'restart' }] },
      assistantWithToolUse('restart_server'),
      toolResult('call_1'),
      { role: 'user', content: [{ type: 'text', text: 'now do something else' }] },
      assistantWithToolUse('web_search'),
      toolResult('call_1'),
    ]
    expect(shouldAutoResume(messages)).toBe(false)
  })

  it('handles trailing user message (tool_result) after enable_plugin', () => {
    // the tool_result is the last message, but the last *assistant* message has enable_plugin
    const messages: Message[] = [
      assistantWithToolUse('enable_plugin'),
      toolResult('call_1'),
    ]
    expect(shouldAutoResume(messages)).toBe(true)
  })
})

describe('getInterruptedTurnResumeContent', () => {
  const baseTurn: ActiveTurnState = {
    sessionId: 'test-session',
    route: 'discord:test',
    outputTarget: 'discord:test',
    pluginName: 'discord',
    startedAt: '2026-04-01T00:00:00.000Z',
    initialContent: [{ type: 'text', text: 'original request' }],
    userMessagePersisted: false,
  }

  it('replays the original content if the user message was never persisted', () => {
    expect(getInterruptedTurnResumeContent(baseTurn, 'server restarted')).toEqual(baseTurn.initialContent)
  })

  it('switches to restartMessage once the user message was already persisted', () => {
    const resumed = getInterruptedTurnResumeContent(
      { ...baseTurn, userMessagePersisted: true },
      'server restarted',
    )
    expect(resumed).toEqual([{ type: 'text', text: 'server restarted' }])
  })
})
