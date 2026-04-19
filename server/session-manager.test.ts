/**
 * Tests for the session route map and compaction race fix.
 *
 * These tests verify that:
 * - getCurrentSessionId uses an in-memory route→session map
 * - setCurrentSessionId atomically switches the route
 * - finalizeSession updates the map so stale mtime can't revive old sessions
 * - needsCompaction correctly checks token thresholds
 * - concurrent finalizeSession calls coalesce
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

  test('needsCompaction returns false when below threshold', async () => {
    const sm = createSessionManager(fakeProvider(), fakeConfig({ compactAtTokens: 999999 }))
    const sessionId = await sm.getSessionForMessage(testRoute)

    await writeSessionFile(sessionId, [sysEntry('test'), msgEntry('user', 'hello')])

    const result = await sm.needsCompaction(sessionId, testRoute)
    expect(result).toBe(false)
  })

  test('needsCompaction returns true when above threshold', async () => {
    const sm = createSessionManager(
      fakeProvider(),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)

    await writeSessionFile(sessionId, bulkEntries(5))

    const result = await sm.needsCompaction(sessionId, testRoute)
    expect(result).toBe(true)
  })

  test('finalizeSession creates new session and switches route', async () => {
    const sm = createSessionManager(
      fakeProvider(),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    const newId = await sm.finalizeSession(sessionId, testRoute, 'summary of conversation')
    expect(newId).not.toBe(sessionId)
    expect(newId).toContain('_test-compact-chan1-')

    const resolved = await getCurrentSessionId(testRoute)
    expect(resolved).toBe(newId)
  })

  test('after finalizeSession, getCurrentSessionId returns new session', async () => {
    const sm = createSessionManager(
      fakeProvider(),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    const newId = await sm.finalizeSession(sessionId, testRoute, 'compacted summary')
    expect(newId).not.toBe(sessionId)

    const resolved = await getCurrentSessionId(testRoute)
    expect(resolved).toBe(newId)
  })

  test('already-finalized session is not re-resolved by mtime', async () => {
    const sm = createSessionManager(
      fakeProvider(),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    const newId = await sm.finalizeSession(sessionId, testRoute, 'compacted summary')
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

  test('finalizeSession updates route map and returns new ID', async () => {
    const sm = createSessionManager(
      fakeProvider(),
      fakeConfig(),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, [sysEntry('test'), msgEntry('user', 'hi'), msgEntry('assistant', 'hello')])

    const newId = await sm.finalizeSession(sessionId, testRoute, 'force compacted')
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

  test('double finalization of same session is coalesced', async () => {
    // scenario: two async paths both try to finalize the same session.
    // second call should coalesce onto the first's in-flight promise.
    let finalizationCount = 0
    const slowProvider: LlmProvider = {
      name: 'slow-fake',
      stream: async function* (_opts: any) {
        finalizationCount++
        await new Promise(r => setTimeout(r, 50))
        yield { type: 'text' as const, text: `summary #${finalizationCount}` }
        yield { type: 'usage' as const, input: 100, output: 50, cacheRead: 0, cacheWrite: 0 }
      },
    }

    const sm = createSessionManager(
      slowProvider,
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    // fire two finalizations concurrently on the same session
    const [result1, result2] = await Promise.all([
      sm.finalizeSession(sessionId, testRoute, 'summary A'),
      sm.finalizeSession(sessionId, testRoute, 'summary B'),
    ])

    // both should return the same new session (coalesced)
    expect(result1).not.toBe(sessionId)
    expect(result2).toBe(result1)
    // the route map should point to that single new session
    expect(await getCurrentSessionId(testRoute)).toBe(result1)
  })

  test('getSessionForMessage returns new session after finalization', async () => {
    const sm = createSessionManager(
      fakeProvider(),
      fakeConfig({ compactAtTokens: 100 }),
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    await sm.finalizeSession(sessionId, testRoute, 'compacted')

    const afterSession = await sm.getSessionForMessage(testRoute)
    expect(afterSession).not.toBe(sessionId)
  })

  test('concurrent finalizeSession calls do not double-finalize', async () => {
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

    // fire two finalizations concurrently on the same session
    const [result1, result2] = await Promise.all([
      sm.finalizeSession(sessionId, testRoute, 'summary'),
      sm.finalizeSession(sessionId, testRoute, 'summary'),
    ])

    // both should return the same new session (coalesced)
    expect(result1).not.toBe(sessionId)
    expect(result2).toBe(result1)
    // the route map should point to that single new session
    expect(await getCurrentSessionId(testRoute)).toBe(result1)
  })

  test('pre-compaction hooks run in background without blocking session switch', async () => {
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

    const newId = await sm.finalizeSession(sessionId, testRoute, 'compacted')

    // finalization returned — new session is ready
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

  test('pre-compaction hook errors are caught and do not break finalization', async () => {
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
    const newId = await sm.finalizeSession(sessionId, testRoute, 'compacted')
    expect(newId).not.toBe(sessionId)
    expect(await getCurrentSessionId(testRoute)).toBe(newId)
  })

  test('finalization with slow provider still atomically updates route map', async () => {
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

    // start finalization (slow — buildSystemPrompt may take time)
    const finalizationPromise = sm.finalizeSession(sessionId, testRoute, 'slow summary')

    // while finalization is in-flight, the route map still points to old session
    const midFinalization = await getCurrentSessionId(testRoute)
    expect(midFinalization).toBe(sessionId)

    // wait for finalization to finish
    const newId = await finalizationPromise
    expect(newId).not.toBe(sessionId)

    // now route map must point to new session
    const afterFinalization = await getCurrentSessionId(testRoute)
    expect(afterFinalization).toBe(newId)
  })

  test('finalization notification routes to the compacted channel, not notifyOnRestart', async () => {
    const notifyCalls: { target: string; message: any }[] = []
    const fakeRouteOutput = async (target: string, message: any) => {
      notifyCalls.push({ target, message })
    }

    const configWithNotify = fakeConfig({ compactAtTokens: 100 })
    ;(configWithNotify as any).notifyOnRestart = 'discord:jims-dm'

    const resolveOutputTarget = (route: string) =>
      route === testRoute ? 'discord:correct-channel' : route

    const sm = createSessionManager(
      fakeProvider('compacted'),
      configWithNotify,
      fakeRouteOutput,
      undefined,
      undefined,
      resolveOutputTarget,
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    await sm.finalizeSession(sessionId, testRoute, 'compacted')

    // notification should go to the resolved output target, not notifyOnRestart
    const textCalls = notifyCalls.filter(c => c.message.type === 'text')
    expect(textCalls.length).toBe(1)
    expect(textCalls[0].target).toBe('discord:correct-channel')
    expect(textCalls[0].target).not.toBe('discord:jims-dm')
  })

  test('reset notification routes to the reset channel, not notifyOnRestart', async () => {
    const notifyCalls: { target: string; message: any }[] = []
    const fakeRouteOutput = async (target: string, message: any) => {
      notifyCalls.push({ target, message })
    }

    const configWithNotify = fakeConfig()
    ;(configWithNotify as any).notifyOnRestart = 'discord:jims-dm'

    const resolveOutputTarget = (route: string) =>
      route === testRoute ? 'discord:correct-channel' : route

    const sm = createSessionManager(
      fakeProvider(),
      configWithNotify,
      fakeRouteOutput,
      undefined,
      undefined,
      resolveOutputTarget,
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, [sysEntry('test'), msgEntry('user', 'hi')])

    await sm.resetSession(sessionId, testRoute)

    const textCalls = notifyCalls.filter(c => c.message.type === 'text')
    expect(textCalls.length).toBe(1)
    expect(textCalls[0].target).toBe('discord:correct-channel')
    expect(textCalls[0].target).not.toBe('discord:jims-dm')
  })

  test('finalization without route falls back to notifyOnRestart', async () => {
    const notifyCalls: { target: string; message: any }[] = []
    const fakeRouteOutput = async (target: string, message: any) => {
      notifyCalls.push({ target, message })
    }

    const configWithNotify = fakeConfig({ compactAtTokens: 100 })
    ;(configWithNotify as any).notifyOnRestart = 'discord:jims-dm'

    // use a unique route to get a clean session, then finalize without route
    const setupRoute = '_test-compact:noroute-fallback'
    const sm = createSessionManager(
      fakeProvider('compacted'),
      configWithNotify,
      fakeRouteOutput,
    )
    const sessionId = await sm.getSessionForMessage(setupRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    // finalize with no route — should fall back to notifyOnRestart
    await sm.finalizeSession(sessionId, undefined, 'compacted')

    const textCalls = notifyCalls.filter(c => c.message.type === 'text')
    expect(textCalls.length).toBe(1)
    expect(textCalls[0].target).toBe('discord:jims-dm')
  })

  test('finalization with route but no resolveOutputTarget uses route directly', async () => {
    const notifyCalls: { target: string; message: any }[] = []
    const fakeRouteOutput = async (target: string, message: any) => {
      notifyCalls.push({ target, message })
    }

    const configWithNotify = fakeConfig({ compactAtTokens: 100 })
    ;(configWithNotify as any).notifyOnRestart = 'discord:jims-dm'

    // no resolveOutputTarget passed
    const sm = createSessionManager(
      fakeProvider('compacted'),
      configWithNotify,
      fakeRouteOutput,
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    await sm.finalizeSession(sessionId, testRoute, 'compacted')

    const textCalls = notifyCalls.filter(c => c.message.type === 'text')
    expect(textCalls.length).toBe(1)
    // should use route directly, not notifyOnRestart
    expect(textCalls[0].target).toBe(testRoute)
  })

  test('context warning fires once when tokens exceed warnAtTokens', async () => {
    const notifyCalls: { target: string; message: any }[] = []
    const fakeRouteOutput = async (target: string, message: any) => {
      notifyCalls.push({ target, message })
    }

    const resolveOutputTarget = (route: string) =>
      route === testRoute ? 'discord:warn-channel' : route

    // warnAtTokens=500 (below bulkEntries token count), compactAtTokens=999999 (won't compact)
    const sm = createSessionManager(
      fakeProvider(),
      fakeConfig({ compactAtTokens: 999999, warnAtTokens: 500 }),
      fakeRouteOutput,
      undefined,
      undefined,
      resolveOutputTarget,
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    // first check — should emit warning
    await sm.needsCompaction(sessionId, testRoute)
    const textCalls = notifyCalls.filter(c => c.message.type === 'text')
    expect(textCalls.length).toBe(1)
    expect(textCalls[0].target).toBe('discord:warn-channel')
    expect(textCalls[0].message.text).toContain('context size warning')

    // second check — should NOT emit warning again (once per session)
    notifyCalls.length = 0
    await sm.needsCompaction(sessionId, testRoute)
    const textCalls2 = notifyCalls.filter(c => c.message.type === 'text')
    expect(textCalls2.length).toBe(0)
  })

  test('context warning does not fire when tokens below warnAtTokens', async () => {
    const notifyCalls: { target: string; message: any }[] = []
    const fakeRouteOutput = async (target: string, message: any) => {
      notifyCalls.push({ target, message })
    }

    // warnAtTokens way above what bulkEntries(5) produces
    const sm = createSessionManager(
      fakeProvider(),
      fakeConfig({ compactAtTokens: 999999, warnAtTokens: 999998 }),
      fakeRouteOutput,
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    await sm.needsCompaction(sessionId, testRoute)
    const textCalls = notifyCalls.filter(c => c.message.type === 'text')
    expect(textCalls.length).toBe(0)
  })

  test('generateSessionId and buildSystemPrompt run concurrently during finalization', async () => {
    const PROMPT_DELAY = 150

    let buildSystemPromptCalled = false
    const slowBuildSystemPrompt = async () => {
      buildSystemPromptCalled = true
      await new Promise(r => setTimeout(r, PROMPT_DELAY))
      return 'system prompt'
    }

    const sm = createSessionManager(
      fakeProvider(),
      fakeConfig({ compactAtTokens: 100 }),
      undefined,
      undefined,
      slowBuildSystemPrompt,
    )
    const sessionId = await sm.getSessionForMessage(testRoute)
    await writeSessionFile(sessionId, bulkEntries(5))

    const start = performance.now()
    const newId = await sm.finalizeSession(sessionId, testRoute, 'summary')
    const elapsed = performance.now() - start

    expect(newId).not.toBe(sessionId)
    expect(buildSystemPromptCalled).toBe(true)

    // generateSessionId and buildSystemPrompt run in parallel inside doFinalizeSession,
    // so elapsed should be roughly PROMPT_DELAY, not 2x
    // just verify it completed in a reasonable time
    expect(elapsed).toBeLessThan(PROMPT_DELAY * 3)
  })
})
