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

  test('queued messages are appended as separate user message after tool results', async () => {
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

    // simulate a message arriving during tool execution (not on the first drain)
    let checkCount = 0
    await runAgentTurn(
      [{ type: 'text', text: 'do something' }],
      makeOptions({
        provider,
        checkQueuedMessages: () => {
          checkCount++
          // first check is at top of loop iteration 1 (before first LLM call) — nothing queued yet
          // second check is at top of loop iteration 2 (after tool results) — message arrived during tools
          if (checkCount === 2) {
            return [{ content: [{ type: 'text', text: 'hey, new context!' }], outputTarget: '' }]
          }
          return []
        },
      }),
    )

    // find the tool result message
    const toolResultMsg = savedMessages.find(m =>
      m.role === 'user' && m.content.some(b => b.type === 'tool_result')
    )
    expect(toolResultMsg).toBeDefined()

    // tool result message should only have tool_result blocks (no queued text mixed in)
    expect(toolResultMsg!.content.every(b => b.type === 'tool_result')).toBe(true)

    // queued text should be in a separate user message after the tool results
    const queuedMsg = savedMessages.find(m =>
      m.role === 'user' && m.content.some(b => b.type === 'text' && b.text === 'hey, new context!')
    )
    expect(queuedMsg).toBeDefined()

    // the queued message should come after the tool result message
    const toolResultIdx = savedMessages.indexOf(toolResultMsg!)
    const queuedIdx = savedMessages.indexOf(queuedMsg!)
    expect(queuedIdx).toBeGreaterThan(toolResultIdx)
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

  test('queued messages during multi-tool do not interrupt — all tools complete', async () => {
    const savedMessages: Message[] = []
    setupSessionMock({
      appendMessage: async (_sid: string, msg: Message) => { savedMessages.push(msg) },
    })

    let toolExecutions = 0
    // response 1: two tool uses, response 2: text acknowledging queued msg
    const provider = makeMockProvider([
      [
        { type: 'tool_use', id: 'tu_1', name: 'test_tool', input: {} },
        { type: 'tool_use', id: 'tu_2', name: 'test_tool', input: {} },
        { type: 'usage', input: 100, output: 50 },
      ],
      [
        { type: 'text', text: 'acknowledged your message' },
        { type: 'usage', input: 100, output: 50 },
      ],
    ])

    // simulate messages arriving during tool execution (not before first LLM call)
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
          // skip the first drain (top of loop before first LLM call)
          if (checkCount <= 1) return []
          // subsequent drains simulate messages arriving during tool execution
          return [{ content: [{ type: 'text' as const, text: 'urgent update!' }], outputTarget: '' }]
        },
      }),
    )

    // both tools should have executed (no interruption)
    expect(toolExecutions).toBe(2)

    // find the tool result message
    const toolResultMsg = savedMessages.find(m =>
      m.role === 'user' && m.content.some(b => b.type === 'tool_result')
    )
    expect(toolResultMsg).toBeDefined()

    const results = toolResultMsg!.content.filter(b => b.type === 'tool_result')
    expect(results).toHaveLength(2)

    // both tool results should be successful (not interrupted)
    for (const r of results) {
      expect(r.type === 'tool_result' && r.is_error).toBeFalsy()
    }

    // queued text should be in a separate user message after tool results
    const queuedMsg = savedMessages.find(m =>
      m.role === 'user' && m.content.some(b => b.type === 'text' && b.text === 'urgent update!')
    )
    expect(queuedMsg).toBeDefined()
    expect(savedMessages.indexOf(queuedMsg!)).toBeGreaterThan(savedMessages.indexOf(toolResultMsg!))
  })
})
