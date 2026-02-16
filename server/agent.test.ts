import { describe, test, expect, mock } from 'bun:test'
import { repairMessages, runAgentTurn, type AgentOptions } from './agent.ts'
import type { Message, StreamChunk } from './types.ts'
import type { LlmProvider } from './llm-provider.ts'

// stub session storage — agent.ts imports loadSession and appendMessage
import * as session from './session.ts'

// session mock helper — sets up mock for agent tests that need it
function setupSessionMock(overrides: Record<string, Function> = {}) {
  mock.module('./session.ts', () => ({
    ...session,
    loadSession: async () => [],
    loadSessionEntries: async () => [],
    loadSystemPrompt: async () => 'mock system prompt',
    loadCostEntries: async () => [],
    appendMessage: async () => {},
    appendEntry: async () => {},
    writeSession: async () => {},
    ...overrides,
  }))
}

describe('repairMessages', () => {
  test('passes through messages with no tool calls', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hello' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }] },
    ]
    expect(repairMessages(msgs)).toEqual(msgs)
  })

  test('adds synthetic tool_result for missing results', () => {
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'do something' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] },
    ]
    const repaired = repairMessages(msgs)
    expect(repaired).toHaveLength(3)
    expect(repaired[2]!.role).toBe('user')
    const block = repaired[2]!.content[0]!
    expect(block.type).toBe('tool_result')
    if (block.type === 'tool_result') {
      expect(block.tool_use_id).toBe('tu_1')
      expect(block.is_error).toBe(true)
    }
  })
})

describe('runAgentTurn queued message handling', () => {
  setupSessionMock()

  function makeMockProvider(responses: StreamChunk[][]): LlmProvider {
    let callCount = 0
    return {
      name: 'mock',
      async *stream() {
        const chunks = responses[callCount++] || []
        for (const chunk of chunks) {
          yield chunk
        }
      },
    }
  }

  function makeOptions(overrides: Partial<AgentOptions> & Pick<AgentOptions, 'provider'>): AgentOptions {
    const { model = 'claude-sonnet-4-5', ...rest } = overrides
    return {
      system: async () => 'test system prompt',
      tools: () => [{
        name: 'test_tool',
        description: 'a test tool',
        inputSchema: { type: 'object', properties: {} },
        execute: async () => ({ content: 'tool result' }),
      }],
      sessionId: 'test-session',
      workingDir: '/tmp',
      model,
      ...rest,
    }
  }

  test('queued messages are appended to tool result message after all tools complete', async () => {
    const savedMessages: Message[] = []
    setupSessionMock({
      appendMessage: async (_sid: string, msg: Message) => { savedMessages.push(msg) },
    })

    // response 1: tool use, response 2: text only
    const provider = makeMockProvider([
      [
        { type: 'tool_use', id: 'tu_1', name: 'test_tool', input: {} },
        { type: 'usage', input: 100, output: 50 },
      ],
      [
        { type: 'text', text: 'got your message' },
        { type: 'usage', input: 100, output: 50 },
      ],
    ])

    let queueReturned = false
    const result = await runAgentTurn(
      [{ type: 'text', text: 'do something' }],
      makeOptions({
        provider,
        checkQueuedMessages: () => {
          if (!queueReturned) {
            queueReturned = true
            return [{ content: [{ type: 'text', text: 'hey, new context!' }], outputTarget: '' }]
          }
          return []
        },
      }),
    )

    // find the message that contains tool_result blocks
    const toolResultMsg = savedMessages.find(m =>
      m.role === 'user' && m.content.some(b => b.type === 'tool_result')
    )
    expect(toolResultMsg).toBeDefined()

    // the queued text should be in the SAME message as the tool result (no [USER INTERRUPT] wrapper)
    const hasQueuedText = toolResultMsg!.content.some(
      b => b.type === 'text' && b.text === 'hey, new context!'
    )
    expect(hasQueuedText).toBe(true)

    // verify no consecutive user messages in the result
    for (let i = 1; i < result.messages.length; i++) {
      if (result.messages[i]!.role === 'user' && result.messages[i - 1]!.role === 'user') {
        throw new Error(`consecutive user messages at index ${i - 1} and ${i}`)
      }
    }
  })

  test('no queued messages produces clean tool result message', async () => {
    const savedMessages: Message[] = []
    setupSessionMock({
      appendMessage: async (_sid: string, msg: Message) => { savedMessages.push(msg) },
    })

    const provider = makeMockProvider([
      [
        { type: 'tool_use', id: 'tu_1', name: 'test_tool', input: {} },
        { type: 'usage', input: 100, output: 50 },
      ],
      [
        { type: 'text', text: 'all done' },
        { type: 'usage', input: 100, output: 50 },
      ],
    ])

    await runAgentTurn(
      [{ type: 'text', text: 'do something' }],
      makeOptions({
        provider,
        checkQueuedMessages: () => [],
      }),
    )

    const toolResultMsg = savedMessages.find(m =>
      m.role === 'user' && m.content.some(b => b.type === 'tool_result')
    )
    // should only have tool_result blocks, no text
    expect(toolResultMsg!.content.every(b => b.type === 'tool_result')).toBe(true)
  })

  test('queued message mid-multi-tool interrupts remaining tools', async () => {
    const savedMessages: Message[] = []
    setupSessionMock({
      appendMessage: async (_sid: string, msg: Message) => { savedMessages.push(msg) },
    })

    let toolExecutions = 0
    // response 1: two tool uses, response 2: text acknowledging interrupt
    const provider = makeMockProvider([
      [
        { type: 'tool_use', id: 'tu_1', name: 'test_tool', input: {} },
        { type: 'tool_use', id: 'tu_2', name: 'test_tool', input: {} },
        { type: 'usage', input: 100, output: 50 },
      ],
      [
        { type: 'text', text: 'acknowledged your interrupt' },
        { type: 'usage', input: 100, output: 50 },
      ],
    ])

    let checkCount = 0
    await runAgentTurn(
      [{ type: 'text', text: 'do two things' }],
      makeOptions({
        provider,
        tools: () => [{
          name: 'test_tool',
          description: 'a test tool',
          inputSchema: { type: 'object', properties: {} },
          execute: async () => {
            toolExecutions++
            return { content: `tool result ${toolExecutions}` }
          },
        }],
        checkQueuedMessages: () => {
          checkCount++
          // return a queued message after the first tool completes
          if (checkCount === 1) {
            return [{ content: [{ type: 'text' as const, text: 'urgent update!' }], outputTarget: '' }]
          }
          return []
        },
      }),
    )

    // only the first tool should have actually executed
    expect(toolExecutions).toBe(1)

    // find the tool result message
    const toolResultMsg = savedMessages.find(m =>
      m.role === 'user' && m.content.some(b => b.type === 'tool_result')
    )
    expect(toolResultMsg).toBeDefined()

    // should have: tool_result for tu_1 (executed), tool_result for tu_2 (interrupted), text (queued msg)
    const blocks = toolResultMsg!.content
    const results = blocks.filter(b => b.type === 'tool_result')
    expect(results).toHaveLength(2)

    // first tool result should be the actual result
    const first = results[0]!
    expect(first.type === 'tool_result' && first.tool_use_id).toBe('tu_1')
    expect(first.type === 'tool_result' && first.is_error).toBeFalsy()

    // second tool result should be the interrupted marker
    const second = results[1]!
    expect(second.type === 'tool_result' && second.tool_use_id).toBe('tu_2')
    expect(second.type === 'tool_result' && second.is_error).toBe(true)

    // queued text should be in the same message
    const hasQueuedText = blocks.some(
      b => b.type === 'text' && b.text === 'urgent update!'
    )
    expect(hasQueuedText).toBe(true)
  })
})
