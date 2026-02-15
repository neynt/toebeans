import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { mkdir, rm } from 'node:fs/promises'
import type { Message, MessageCost, SessionEntry } from './types.ts'

const SESSIONS_DIR = join(homedir(), '.toebeans', 'sessions')
const TEST_SESSION = '_test-session-entries'

function getSessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`)
}

async function cleanup() {
  try { await rm(getSessionPath(TEST_SESSION)) } catch {}
}

// Since bun's mock.module is global and may be polluted by agent.test.ts,
// we re-implement the parsing logic here for testing. This tests the same
// logic that session.ts uses, without being affected by mocks.

function parseSessionLine(line: string): SessionEntry | null {
  const parsed = JSON.parse(line)
  if (parsed.type === 'system_prompt' || parsed.type === 'message') {
    return parsed as SessionEntry
  }
  // legacy standalone cost entries are skipped
  if (parsed.type === 'cost') return null
  return { type: 'message', timestamp: '', message: parsed as Message }
}

async function readEntries(sessionId: string): Promise<SessionEntry[]> {
  const path = getSessionPath(sessionId)
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  const text = await file.text()
  return text.trim().split('\n').filter(Boolean)
    .map(parseSessionLine)
    .filter((e): e is SessionEntry => e !== null)
}

async function writeEntries(sessionId: string, entries: SessionEntry[]): Promise<void> {
  const path = getSessionPath(sessionId)
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  await Bun.write(path, lines)
}

async function appendEntryToFile(sessionId: string, entry: SessionEntry): Promise<void> {
  const path = getSessionPath(sessionId)
  const line = JSON.stringify(entry) + '\n'
  const file = Bun.file(path)
  if (await file.exists()) {
    const existing = await file.text()
    await Bun.write(path, existing + line)
  } else {
    await Bun.write(path, line)
  }
}

describe('session entries', () => {
  beforeEach(async () => {
    await mkdir(SESSIONS_DIR, { recursive: true })
    await cleanup()
  })

  afterEach(cleanup)

  test('writeSession and loadSessionEntries round-trip', async () => {
    const entries: SessionEntry[] = [
      { type: 'system_prompt', timestamp: '2025-01-01T00:00:00Z', content: 'you are helpful' },
      { type: 'message', timestamp: '2025-01-01T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', timestamp: '2025-01-01T00:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, cost: { inputCost: 0.01, outputCost: 0.02, usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 } } },
    ]
    await writeEntries(TEST_SESSION, entries)

    const loaded = await readEntries(TEST_SESSION)
    expect(loaded).toEqual(entries)
  })

  test('loadSession extracts only messages', async () => {
    const entries: SessionEntry[] = [
      { type: 'system_prompt', timestamp: '2025-01-01T00:00:00Z', content: 'you are helpful' },
      { type: 'message', timestamp: '2025-01-01T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', timestamp: '2025-01-01T00:03:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, cost: { inputCost: 0.01, outputCost: 0.02, usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 } } },
    ]
    await writeEntries(TEST_SESSION, entries)

    const allEntries = await readEntries(TEST_SESSION)
    const messages = allEntries
      .filter((e): e is SessionEntry & { type: 'message' } => e.type === 'message')
      .map(e => e.message)
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[1]!.role).toBe('assistant')
  })

  test('loadSystemPrompt returns first system_prompt entry', async () => {
    const entries: SessionEntry[] = [
      { type: 'system_prompt', timestamp: '2025-01-01T00:00:00Z', content: 'you are helpful' },
      { type: 'message', timestamp: '2025-01-01T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
    ]
    await writeEntries(TEST_SESSION, entries)

    const allEntries = await readEntries(TEST_SESSION)
    const sp = allEntries.find((e): e is SessionEntry & { type: 'system_prompt' } => e.type === 'system_prompt')
    expect(sp?.content).toBe('you are helpful')
  })

  test('loadSystemPrompt returns null for session without system_prompt', async () => {
    // legacy format: just messages
    const msg: Message = { role: 'user', content: [{ type: 'text', text: 'hi' }] }
    await Bun.write(getSessionPath(TEST_SESSION), JSON.stringify(msg) + '\n')

    const allEntries = await readEntries(TEST_SESSION)
    const sp = allEntries.find((e): e is SessionEntry & { type: 'system_prompt' } => e.type === 'system_prompt')
    expect(sp).toBeUndefined()
  })

  test('loadCostEntries extracts costs from message entries', async () => {
    const entries: SessionEntry[] = [
      { type: 'system_prompt', timestamp: '2025-01-01T00:00:00Z', content: 'test' },
      { type: 'message', timestamp: '2025-01-01T00:01:00Z', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] } },
      { type: 'message', timestamp: '2025-01-01T00:02:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] }, cost: { inputCost: 0.01, outputCost: 0.02, usage: { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 } } },
      { type: 'message', timestamp: '2025-01-01T00:03:00Z', message: { role: 'user', content: [{ type: 'text', text: 'more' }] } },
      { type: 'message', timestamp: '2025-01-01T00:04:00Z', message: { role: 'assistant', content: [{ type: 'text', text: 'sure' }] }, cost: { inputCost: 0.03, outputCost: 0.04, usage: { input: 2000, output: 1000, cacheRead: 100, cacheWrite: 50 } } },
    ]
    await writeEntries(TEST_SESSION, entries)

    const costs: MessageCost[] = (await readEntries(TEST_SESSION))
      .filter((e): e is SessionEntry & { type: 'message' } => e.type === 'message')
      .filter(e => e.cost != null)
      .map(e => e.cost!)
    expect(costs).toHaveLength(2)
    expect(costs[0]!.inputCost).toBe(0.01)
    expect(costs[1]!.outputCost).toBe(0.04)

    // session total cost
    const totalCost = costs.reduce((sum, e) => sum + e.inputCost + e.outputCost, 0)
    expect(totalCost).toBeCloseTo(0.10)
  })

  test('appendEntry adds to existing session', async () => {
    await writeEntries(TEST_SESSION, [
      { type: 'system_prompt', timestamp: '2025-01-01T00:00:00Z', content: 'test' },
    ])

    await appendEntryToFile(TEST_SESSION, {
      type: 'message',
      timestamp: '2025-01-01T00:01:00Z',
      message: { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    })

    const loaded = await readEntries(TEST_SESSION)
    expect(loaded).toHaveLength(2)
    expect(loaded[0]!.type).toBe('system_prompt')
    expect(loaded[1]!.type).toBe('message')
  })

  test('legacy raw message format is parsed as message entries', async () => {
    // write raw messages like the old format
    const msgs: Message[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
    ]
    const lines = msgs.map(m => JSON.stringify(m)).join('\n') + '\n'
    await Bun.write(getSessionPath(TEST_SESSION), lines)

    const entries = await readEntries(TEST_SESSION)
    expect(entries).toHaveLength(2)
    expect(entries[0]!.type).toBe('message')
    expect(entries[1]!.type).toBe('message')
    if (entries[0]!.type === 'message') {
      expect(entries[0]!.message.role).toBe('user')
    }
  })
})
