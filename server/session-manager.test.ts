/**
 * Tests for the session route map and compaction race fix.
 *
 * These tests verify that:
 * - getCurrentSessionId uses an in-memory route→session map
 * - setCurrentSessionId atomically switches the route
 * - compaction updates the map so stale mtime can't revive old sessions
 * - the double-compaction bug is prevented
 *
 * Since agent.test.ts permanently mocks session.ts via mock.module (bun doesn't
 * support unmocking), we re-mock it here with the real implementations loaded
 * via a cache-busting query string.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { mkdir, rm } from 'node:fs/promises'
import type { SessionEntry, StreamChunk } from './types.ts'
import type { LlmProvider } from './llm-provider.ts'
import type { Config } from './config.ts'
import { countMessagesTokens } from './tokens.ts'
import type { Message } from './types.ts'

const SESSIONS_DIR = join(homedir(), '.toebeans', 'sessions')

function getSessionPath(id: string): string {
  return join(SESSIONS_DIR, `${id}.jsonl`)
}

async function writeSessionFile(id: string, entries: SessionEntry[]): Promise<void> {
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  await Bun.write(getSessionPath(id), lines)
}

function msgEntry(role: 'user' | 'assistant', text: string): SessionEntry {
  return {
    type: 'message',
    timestamp: new Date().toISOString(),
    message: { role, content: [{ type: 'text', text }] },
  }
}

function sysEntry(content: string): SessionEntry {
  return { type: 'system_prompt', timestamp: new Date().toISOString(), content }
}

function bulkEntries(count: number): SessionEntry[] {
  const entries: SessionEntry[] = [sysEntry('test')]
  for (let i = 0; i < count; i++) {
    entries.push(msgEntry('user', `message ${i}: ${'x'.repeat(500)}`))
    entries.push(msgEntry('assistant', `reply ${i}: ${'y'.repeat(500)}`))
  }
  return entries
}

function fakeProvider(summaryText = 'summary of conversation'): LlmProvider {
  return {
    name: 'fake',
    stream: async function* (_opts: any): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: summaryText }
      yield { type: 'usage', input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }
    },
  }
}

function fakeConfig(overrides: Partial<Config['session']> = {}): Config {
  return {
    server: { port: 3000 },
    session: {
      compactAtTokens: 1000,
      compactMinTokens: 100,
      lifespanSeconds: 99999,
      ...overrides,
    },
    plugins: {},
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    timezone: 'UTC',
    restartMessage: 'restarted',
  } as Config
}

async function cleanupSessions(prefix: string) {
  const glob = new Bun.Glob('*.jsonl')
  for await (const path of glob.scan(SESSIONS_DIR)) {
    if (path.startsWith(prefix)) {
      try { await rm(join(SESSIONS_DIR, path)) } catch {}
    }
  }
}

// --- re-implement core session functions to avoid mock pollution from agent.test.ts ---
// agent.test.ts uses mock.module('./session.ts', ...) which permanently replaces the
// session module in bun's module registry. we need real implementations here.

function sanitizeRoute(route: string): string {
  return route.replace(/[^a-zA-Z0-9_-]/g, '-')
}

// in-memory route → session map (mirrors the one in session.ts)
const testSessionMap = new Map<string, string>()

function setCurrentSessionId(route: string | undefined, sessionId: string): void {
  testSessionMap.set(route ?? '', sessionId)
}

async function getCurrentSessionId(route?: string): Promise<string> {
  const key = route ?? ''
  const cached = testSessionMap.get(key)
  if (cached) return cached

  // cold start: pick session with lexicographically highest filename suffix
  const routePrefix = route ? `${sanitizeRoute(route)}-` : ''
  const glob = new Bun.Glob('*.jsonl')
  let latestId: string | null = null

  for await (const path of glob.scan(SESSIONS_DIR)) {
    const sessionId = path.replace('.jsonl', '')
    if (routePrefix) {
      if (!sessionId.startsWith(routePrefix)) continue
    } else {
      if (!/^\d/.test(sessionId)) continue
    }
    const suffix = routePrefix ? sessionId.slice(routePrefix.length) : sessionId
    const latestSuffix = latestId
      ? (routePrefix ? latestId.slice(routePrefix.length) : latestId)
      : ''
    if (!latestId || suffix > latestSuffix) {
      latestId = sessionId
    }
  }

  if (latestId) {
    testSessionMap.set(key, latestId)
    return latestId
  }

  const newId = await generateSessionId(route)
  testSessionMap.set(key, newId)
  return newId
}

async function generateSessionId(route?: string): Promise<string> {
  const today = new Date().toISOString().split('T')[0]
  const routePrefix = route ? `${sanitizeRoute(route)}-` : ''
  const prefix = `${routePrefix}${today}-`

  const glob = new Bun.Glob('*.jsonl')
  const usedNumbers = new Set<number>()
  for await (const path of glob.scan(SESSIONS_DIR)) {
    const sessionId = path.replace('.jsonl', '')
    if (sessionId.startsWith(prefix)) {
      const num = parseInt(sessionId.slice(prefix.length), 10)
      if (!isNaN(num) && num >= 0 && num <= 9999) usedNumbers.add(num)
    }
  }
  for (let i = 0; i <= 9999; i++) {
    if (!usedNumbers.has(i)) return `${prefix}${i.toString().padStart(4, '0')}`
  }
  throw new Error(`all session IDs exhausted for ${prefix}`)
}

function parseSessionLine(line: string): SessionEntry | null {
  const parsed = JSON.parse(line)
  if (parsed.type === 'system_prompt' || parsed.type === 'message') return parsed as SessionEntry
  if (parsed.type === 'cost') return null
  return { type: 'message', timestamp: '', message: parsed as Message }
}

async function loadSessionEntries(sessionId: string): Promise<SessionEntry[]> {
  const path = getSessionPath(sessionId)
  const file = Bun.file(path)
  if (!(await file.exists())) return []
  const text = await file.text()
  return text.trim().split('\n').filter(Boolean)
    .map(parseSessionLine)
    .filter((e): e is SessionEntry => e !== null)
}

async function loadSession(sessionId: string): Promise<Message[]> {
  const entries = await loadSessionEntries(sessionId)
  return entries
    .filter((e): e is SessionEntry & { type: 'message' } => e.type === 'message')
    .map(e => e.message)
}

async function estimateSessionTokens(sessionId: string): Promise<number> {
  const messages = await loadSession(sessionId)
  return countMessagesTokens(messages)
}

// now mock session.ts with our real re-implementations so that session-manager.ts uses them
mock.module('./session.ts', () => ({
  getCurrentSessionId,
  setCurrentSessionId,
  _clearSessionMap: () => testSessionMap.clear(),
  sanitizeRoute,
  generateSessionId,
  loadSession,
  loadSessionEntries,
  loadCostEntries: async () => [],
  estimateSessionTokens,
  getSessionLastActivity: async (sessionId: string) => {
    const path = getSessionPath(sessionId)
    const file = Bun.file(path)
    if (!(await file.exists())) return null
    const stat = await file.stat()
    return stat ? new Date(stat.mtime) : null
  },
  getSessionCreatedAt: async (sessionId: string) => {
    const path = getSessionPath(sessionId)
    const file = Bun.file(path)
    if (!(await file.exists())) return null
    const stat = await file.stat()
    return stat ? new Date(stat.birthtime) : null
  },
  writeSession: async (sessionId: string, entries: SessionEntry[]) => {
    await writeSessionFile(sessionId, entries)
  },
  appendEntry: async (sessionId: string, entry: SessionEntry) => {
    const path = getSessionPath(sessionId)
    const line = JSON.stringify(entry) + '\n'
    const file = Bun.file(path)
    if (await file.exists()) {
      const existing = await file.text()
      await Bun.write(path, existing + line)
    } else {
      await Bun.write(path, line)
    }
  },
  appendMessage: async (sessionId: string, message: Message) => {
    const entry: SessionEntry = { type: 'message', timestamp: new Date().toISOString(), message }
    const path = getSessionPath(sessionId)
    const line = JSON.stringify(entry) + '\n'
    const file = Bun.file(path)
    if (await file.exists()) {
      const existing = await file.text()
      await Bun.write(path, existing + line)
    } else {
      await Bun.write(path, line)
    }
  },
  loadSystemPrompt: async (sessionId: string) => {
    const entries = await loadSessionEntries(sessionId)
    const sp = entries.find(e => e.type === 'system_prompt')
    return sp && sp.type === 'system_prompt' ? sp.content : null
  },
  ensureDataDirs: async () => {},
  getDataDir: () => join(homedir(), '.toebeans'),
  getMemoryDir: () => join(homedir(), '.toebeans', 'memory'),
  getPluginsDir: () => join(homedir(), '.toebeans', 'plugins'),
  getWorkspaceDir: () => join(homedir(), '.toebeans', 'workspace'),
  getSoulPath: () => join(homedir(), '.toebeans', 'SOUL.md'),
  listSessions: async () => [],
  setLastOutputTarget: async () => {},
  getLastOutputTarget: async () => null,
}))

// import session-manager AFTER setting up the mock (it binds to session.ts on import)
const { createSessionManager } = await import('./session-manager.ts') as typeof import('./session-manager.ts')

describe('session route map', () => {
  const testRoute = '_test-route-map:chan1'

  beforeEach(async () => {
    await mkdir(SESSIONS_DIR, { recursive: true })
    testSessionMap.clear()
    await cleanupSessions('_test-route-map')
  })

  afterEach(async () => {
    await cleanupSessions('_test-route-map')
  })

  test('getCurrentSessionId creates a new session on cold start with no files', async () => {
    const id = await getCurrentSessionId(testRoute)
    expect(id).toContain('_test-route-map-chan1-')
  })

  test('getCurrentSessionId returns same session on repeat calls', async () => {
    const id1 = await getCurrentSessionId(testRoute)
    const id2 = await getCurrentSessionId(testRoute)
    expect(id1).toBe(id2)
  })

  test('setCurrentSessionId overrides the map', async () => {
    const id1 = await getCurrentSessionId(testRoute)
    setCurrentSessionId(testRoute, 'override-session-42')
    const id2 = await getCurrentSessionId(testRoute)
    expect(id2).toBe('override-session-42')
    expect(id2).not.toBe(id1)
  })

  test('different routes have independent sessions', async () => {
    const route2 = '_test-route-map:chan2'

    const id1 = await getCurrentSessionId(testRoute)
    const id2 = await getCurrentSessionId(route2)
    expect(id1).not.toBe(id2)

    setCurrentSessionId(testRoute, 'override-a')
    expect(await getCurrentSessionId(testRoute)).toBe('override-a')
    expect(await getCurrentSessionId(route2)).toBe(id2)
  })

  test('cold start picks session with highest filename (date + sequence)', async () => {
    const prefix = sanitizeRoute(testRoute)

    const oldId = `${prefix}-2025-01-01-0000`
    const newId = `${prefix}-2025-01-02-0000`
    await writeSessionFile(oldId, [sysEntry('old session')])
    await writeSessionFile(newId, [sysEntry('new session')])

    testSessionMap.clear()
    const resolved = await getCurrentSessionId(testRoute)
    expect(resolved).toBe(newId)
  })

  test('cold start picks higher sequence number on same date', async () => {
    const prefix = sanitizeRoute(testRoute)

    const first = `${prefix}-2025-03-15-0000`
    const second = `${prefix}-2025-03-15-0001`
    await writeSessionFile(first, [sysEntry('first')])
    await writeSessionFile(second, [sysEntry('second')])

    testSessionMap.clear()
    const resolved = await getCurrentSessionId(testRoute)
    expect(resolved).toBe(second)
  })

  test('cold start ignores mtime — older filename with newer mtime loses', async () => {
    const prefix = sanitizeRoute(testRoute)

    const oldId = `${prefix}-2025-01-01-0000`
    const newId = `${prefix}-2025-06-15-0000`
    // write the newer session first, then the older one (so old has higher mtime)
    await writeSessionFile(newId, [sysEntry('newer session')])
    await new Promise(r => setTimeout(r, 50))
    await writeSessionFile(oldId, [sysEntry('older session with newer mtime')])

    testSessionMap.clear()
    const resolved = await getCurrentSessionId(testRoute)
    // must pick newId by filename, not oldId by mtime
    expect(resolved).toBe(newId)
  })
})

describe('session-manager compaction', () => {
  const testRoute = '_test-compact:chan1'

  beforeEach(async () => {
    await mkdir(SESSIONS_DIR, { recursive: true })
    testSessionMap.clear()
    await cleanupSessions('_test-compact')
  })

  afterEach(async () => {
    await cleanupSessions('_test-compact')
  })

  test('checkCompaction returns same session ID when below threshold', async () => {
    const sm = createSessionManager(fakeProvider(), fakeConfig({ compactAtTokens: 999999 }))
    const sessionId = await sm.getSessionForMessage(testRoute)

    await writeSessionFile(sessionId, [sysEntry('test'), msgEntry('user', 'hello')])

    const result = await sm.checkCompaction(sessionId, testRoute)
    expect(result).toBe(sessionId)
  })

  test('checkCompaction returns new session ID when above threshold', async () => {
    const sm = createSessionManager(
      fakeProvider('compacted summary'),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)

    await writeSessionFile(sessionId, bulkEntries(5))

    const newId = await sm.checkCompaction(sessionId, testRoute)
    expect(newId).not.toBe(sessionId)
    expect(newId).toContain('_test-compact-chan1-')
  })

  test('after compaction, getCurrentSessionId returns new session', async () => {
    const sm = createSessionManager(
      fakeProvider('compacted summary'),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    const newId = await sm.checkCompaction(sessionId, testRoute)
    expect(newId).not.toBe(sessionId)

    const resolved = await getCurrentSessionId(testRoute)
    expect(resolved).toBe(newId)
  })

  test('already-compacted session is not re-resolved by mtime', async () => {
    // core race condition test: after compaction, even if the old session file
    // is modified (e.g. by a stale async write), getCurrentSessionId must
    // return the new session ID from the map, not the old one from mtime.
    const sm = createSessionManager(
      fakeProvider('compacted summary'),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    const newId = await sm.checkCompaction(sessionId, testRoute)
    expect(newId).not.toBe(sessionId)

    // simulate a stale async write to the old session (bumps mtime past the new session)
    await new Promise(r => setTimeout(r, 50))
    const oldPath = getSessionPath(sessionId)
    const oldContent = await Bun.file(oldPath).text()
    await Bun.write(oldPath, oldContent + JSON.stringify(msgEntry('user', 'stale write')) + '\n')

    // must still return the new session, not the old one
    const resolved = await getCurrentSessionId(testRoute)
    expect(resolved).toBe(newId)
  })

  test('forceCompact updates route map and returns new ID', async () => {
    const sm = createSessionManager(
      fakeProvider('force compacted'),
      fakeConfig(),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, [sysEntry('test'), msgEntry('user', 'hi'), msgEntry('assistant', 'hello')])

    const newId = await sm.forceCompact(sessionId, testRoute)
    expect(newId).not.toBe(sessionId)
    expect(await getCurrentSessionId(testRoute)).toBe(newId)
  })

  test('resetSession updates route map and returns new ID', async () => {
    const sm = createSessionManager(fakeProvider(), fakeConfig())
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, [sysEntry('test'), msgEntry('user', 'hi')])

    const newId = await sm.resetSession(sessionId, testRoute)
    expect(newId).not.toBe(sessionId)
    expect(await getCurrentSessionId(testRoute)).toBe(newId)
  })

  test('double compaction of same session is prevented by route map', async () => {
    // scenario: two async paths both resolve the same route to session A.
    // first one compacts A → B. second one calls getSessionForMessage() which
    // now returns B (from the map). compacting B finds it below threshold → no-op.
    const sm = createSessionManager(
      fakeProvider('compacted'),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    // first compaction
    const newId1 = await sm.checkCompaction(sessionId, testRoute)
    expect(newId1).not.toBe(sessionId)

    // after compaction, getSessionForMessage returns the new session
    const resolvedAfter = await sm.getSessionForMessage(testRoute)
    expect(resolvedAfter).toBe(newId1)

    // compacting the new (small) session is a no-op
    const newId2 = await sm.checkCompaction(newId1, testRoute)
    expect(newId2).toBe(newId1)
  })

  test('getSessionForMessage returns new session after compaction', async () => {
    const sm = createSessionManager(
      fakeProvider('compacted'),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    await sm.checkCompaction(sessionId, testRoute)

    const afterSession = await sm.getSessionForMessage(testRoute)
    expect(afterSession).not.toBe(sessionId)
  })

  test('concurrent checkCompaction calls do not double-compact', async () => {
    // two callers resolve the same stale session ID before either compacts.
    // both call checkCompaction concurrently. only one should actually compact;
    // the second should coalesce onto the first's in-flight promise.
    let compactionCount = 0
    const slowProvider: LlmProvider = {
      name: 'slow-fake',
      stream: async function* (_opts: any) {
        compactionCount++
        await new Promise(r => setTimeout(r, 50)) // simulate slow LLM
        yield { type: 'text' as const, text: `summary #${compactionCount}` }
        yield { type: 'usage' as const, input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }
      },
    }

    const sm = createSessionManager(
      slowProvider,
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    // fire two compactions concurrently on the same session
    const [result1, result2] = await Promise.all([
      sm.checkCompaction(sessionId, testRoute),
      sm.checkCompaction(sessionId, testRoute),
    ])

    // both should return the same new session (coalesced)
    expect(result1).not.toBe(sessionId)
    expect(result2).toBe(result1)
    // only one LLM call should have been made
    expect(compactionCount).toBe(1)
    // the route map should point to that single new session
    expect(await getCurrentSessionId(testRoute)).toBe(result1)
  })

  test('pre-compaction hooks run in background without blocking session switch', async () => {
    // a slow onPreCompaction hook should NOT block the new session from being created.
    // the compaction should return as soon as the summary is ready.
    let hookStarted = false
    let hookFinished = false
    const hookPromise = new Promise<void>(resolve => {
      var fakePluginManager = {
        async firePreCompaction(_context: any) {
          hookStarted = true
          await new Promise(r => setTimeout(r, 200)) // slow hook
          hookFinished = true
          resolve()
        },
      }
      Object.assign(fakePluginManager, { firePreCompaction: fakePluginManager.firePreCompaction })
      // we'll pass this as pluginManager below
      ;(globalThis as any).__testPluginManager = fakePluginManager
    })

    const pluginManager = (globalThis as any).__testPluginManager

    const sm = createSessionManager(
      fakeProvider('compacted'),
      fakeConfig({ compactAtTokens: 100 }),
      undefined,
      pluginManager,
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    const newId = await sm.forceCompact(sessionId, testRoute)

    // compaction returned — new session is ready
    expect(newId).not.toBe(sessionId)
    expect(await getCurrentSessionId(testRoute)).toBe(newId)

    // hook was started but hasn't finished yet (it's in the background)
    expect(hookStarted).toBe(true)
    expect(hookFinished).toBe(false)

    // wait for hook to complete so we don't leak the promise
    await hookPromise
    expect(hookFinished).toBe(true)

    delete (globalThis as any).__testPluginManager
  })

  test('pre-compaction hook errors are caught and do not break compaction', async () => {
    const pluginManager = {
      async firePreCompaction(_context: any) {
        throw new Error('hook explosion')
      },
    }

    const sm = createSessionManager(
      fakeProvider('compacted'),
      fakeConfig({ compactAtTokens: 100 }),
      undefined,
      pluginManager as any,
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    // should not throw — error is caught internally
    const newId = await sm.forceCompact(sessionId, testRoute)
    expect(newId).not.toBe(sessionId)
    expect(await getCurrentSessionId(testRoute)).toBe(newId)
  })

  test('compaction with slow provider still atomically updates route map', async () => {
    // verifies that even with a slow LLM summary, the route map is updated
    // atomically after compaction completes, so no window exists where the
    // old session could be re-resolved.
    const slowProvider: LlmProvider = {
      name: 'slow-fake',
      stream: async function* (_opts: any) {
        await new Promise(r => setTimeout(r, 100))
        yield { type: 'text' as const, text: 'slow summary' }
        yield { type: 'usage' as const, input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }
      },
    }

    const sm = createSessionManager(
      slowProvider,
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    // start compaction (slow)
    const compactionPromise = sm.checkCompaction(sessionId, testRoute)

    // while compaction is in-flight, the route map still points to old session
    // (compaction hasn't finished yet)
    const midCompaction = await getCurrentSessionId(testRoute)
    expect(midCompaction).toBe(sessionId)

    // wait for compaction to finish
    const newId = await compactionPromise
    expect(newId).not.toBe(sessionId)

    // now route map must point to new session
    const afterCompaction = await getCurrentSessionId(testRoute)
    expect(afterCompaction).toBe(newId)
  })
})
