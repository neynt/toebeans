import { describe, test, expect, mock, beforeEach } from 'bun:test'
import type { ToolContext, Message, ServerMessage } from '../../server/types.ts'

// mock session.ts before importing the plugin
const mockSessions = [
  { id: 'discord-general-2026-04-01-0001', createdAt: new Date('2026-04-01T10:00:00Z'), lastActiveAt: new Date('2026-04-01T12:00:00Z') },
  { id: '2026-04-01-0000', createdAt: new Date('2026-04-01T08:00:00Z'), lastActiveAt: new Date('2026-04-01T11:00:00Z') },
  { id: 'subagent-abc-2026-04-01-0000', createdAt: new Date('2026-04-01T09:00:00Z'), lastActiveAt: new Date('2026-04-01T09:30:00Z') },
]
const mockActiveRoutes = new Map([
  ['discord:general', 'discord-general-2026-04-01-0001'],
  ['', '2026-04-01-0000'],
])
const appendedMessages: { sessionId: string; message: Message }[] = []
const mockMessages: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'do a task' }] },
  { role: 'assistant', content: [{ type: 'text', text: 'done! here is the result.' }] },
]

mock.module('../../server/session.ts', () => ({
  listSessions: async () => [...mockSessions],
  getActiveRoutes: () => new Map(mockActiveRoutes),
  getCurrentSessionId: async (route?: string) => {
    for (const [r, sid] of mockActiveRoutes) {
      if (r === (route ?? '')) return sid
    }
    return `${route}-2026-04-01-0000`
  },
  appendMessage: async (sessionId: string, message: Message) => {
    appendedMessages.push({ sessionId, message })
  },
  loadSession: async () => [...mockMessages],
}))

// import after mocking
const createPlugin = (await import('./index.ts')).default

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: '2026-04-01-0000',
    workingDir: '/tmp',
    ...overrides,
  }
}

describe('sessions plugin', () => {
  let plugin: ReturnType<typeof createPlugin>

  beforeEach(() => {
    appendedMessages.length = 0
    plugin = createPlugin({})
  })

  describe('list_sessions', () => {
    test('returns sessions sorted by activity with route info', async () => {
      const tool = plugin.tools!.find(t => t.name === 'list_sessions')!
      const result = await tool.execute({}, makeContext())
      const sessions = JSON.parse(result.content as string)

      expect(sessions).toHaveLength(3)
      // first session should be most recently active
      expect(sessions[0].sessionId).toBe('discord-general-2026-04-01-0001')
      expect(sessions[0].route).toBe('discord:general')
      expect(sessions[0].filePath).toContain('discord-general-2026-04-01-0001.jsonl')
      expect(sessions[0].isCurrentForRoute).toBe(true)
    })

    test('respects limit parameter', async () => {
      const tool = plugin.tools!.find(t => t.name === 'list_sessions')!
      const result = await tool.execute({ limit: 1 }, makeContext())
      const sessions = JSON.parse(result.content as string)
      expect(sessions).toHaveLength(1)
    })

    test('marks caller session', async () => {
      const tool = plugin.tools!.find(t => t.name === 'list_sessions')!
      const result = await tool.execute({}, makeContext({ sessionId: '2026-04-01-0000' }))
      const sessions = JSON.parse(result.content as string)
      const caller = sessions.find((s: any) => s.sessionId === '2026-04-01-0000')
      expect(caller.isCallerSession).toBe(true)
    })

    test('infers route from session ID when not in active routes', async () => {
      const tool = plugin.tools!.find(t => t.name === 'list_sessions')!
      const result = await tool.execute({}, makeContext())
      const sessions = JSON.parse(result.content as string)
      const subagent = sessions.find((s: any) => s.sessionId === 'subagent-abc-2026-04-01-0000')
      expect(subagent.route).toBe('subagent-abc')
    })
  })

  describe('send_message', () => {
    test('silent mode appends directly to session JSONL', async () => {
      const tool = plugin.tools!.find(t => t.name === 'send_message')!
      const result = await tool.execute({
        route: 'discord:general',
        message: 'hello from another session',
        silent: true,
      }, makeContext())

      expect(result.is_error).toBeFalsy()
      expect(appendedMessages).toHaveLength(1)
      expect(appendedMessages[0].sessionId).toBe('discord-general-2026-04-01-0001')
      const text = (appendedMessages[0].message.content[0] as any).text
      expect(text).toContain('hello from another session')
      expect(text).toContain('[from session')
    })

    test('non-silent mode queues through input generator', async () => {
      const tool = plugin.tools!.find(t => t.name === 'send_message')!
      const result = await tool.execute({
        route: 'discord:general',
        message: 'wake up!',
      }, makeContext())

      expect(result.is_error).toBeFalsy()
      expect((result.content as string)).toContain('message sent')

      // the input generator should have a message queued
      const inputIter = plugin.input![Symbol.asyncIterator]()
      const { value } = await inputIter.next()
      expect(value.route).toBe('discord:general')
      expect(value.message.content[0].text).toContain('wake up!')
    })

    test('rejects missing route or message', async () => {
      const tool = plugin.tools!.find(t => t.name === 'send_message')!
      const result = await tool.execute({ route: 'x' }, makeContext())
      expect(result.is_error).toBe(true)
    })
  })

  describe('spawn_session', () => {
    test('creates a subagent session and queues initial prompt', async () => {
      const tool = plugin.tools!.find(t => t.name === 'spawn_session')!
      const result = await tool.execute({
        prompt: 'research quantum computing',
      }, makeContext({ outputTarget: 'discord:general' }))

      const parsed = JSON.parse(result.content as string)
      expect(parsed.spawnId).toBeTruthy()
      expect(parsed.route).toMatch(/^subagent-/)

      // check input generator has the message
      const inputIter = plugin.input![Symbol.asyncIterator]()
      const { value } = await inputIter.next()
      expect(value.route).toBe(parsed.route)
      expect(value.outputTarget).toBe(`sessions:${parsed.spawnId}`)
      expect(value.message.content[0].text).toBe('research quantum computing')
    })

    test('custom route prefix', async () => {
      const tool = plugin.tools!.find(t => t.name === 'spawn_session')!
      const result = await tool.execute({
        prompt: 'do a thing',
        route_prefix: 'worker',
      }, makeContext())

      const parsed = JSON.parse(result.content as string)
      expect(parsed.route).toMatch(/^worker-/)
    })

    test('reports spawned sessions in status', async () => {
      const tool = plugin.tools!.find(t => t.name === 'spawn_session')!
      await tool.execute({ prompt: 'task 1' }, makeContext())
      await tool.execute({ prompt: 'task 2' }, makeContext())

      const status = await plugin.status!()
      expect(status).not.toBeNull()
      expect(status!.tasks).toHaveLength(2)
    })
  })

  describe('output handler (spawn completion)', () => {
    test('notifies caller when spawned session completes', async () => {
      // drain any prior queued inputs
      const inputIter = plugin.input![Symbol.asyncIterator]()

      // spawn a session
      const tool = plugin.tools!.find(t => t.name === 'spawn_session')!
      const result = await tool.execute({
        prompt: 'do research',
      }, makeContext({ sessionId: '2026-04-01-0000', outputTarget: 'discord:general' }))
      const parsed = JSON.parse(result.content as string)

      // drain the spawn message from input
      await inputIter.next()

      // simulate the spawned session completing — server calls our output handler
      await plugin.output!(parsed.spawnId, {
        type: 'done',
        usage: { input: 100, output: 50 },
      } as ServerMessage)

      // should have queued a notification back to the caller
      const { value: notification } = await inputIter.next()
      expect(notification.message.content[0].text).toContain('spawn_session completed')
      expect(notification.message.content[0].text).toContain('done! here is the result.')
      expect(notification.triggerNotice).toContain('completed')

      // spawned session should be removed from tracking
      const status = await plugin.status!()
      expect(status).toBeNull()
    })
  })
})
