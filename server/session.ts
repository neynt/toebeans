import { mkdir } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Message, SessionInfo } from './types.ts'
import { countMessagesTokens } from './tokens.ts'

const TOEBEANS_DIR = join(homedir(), '.toebeans')
const SESSIONS_DIR = join(TOEBEANS_DIR, 'sessions')
const STATE_PATH = join(TOEBEANS_DIR, 'state.json')

interface SessionState {
  currentSessionId: string | null  // legacy, migrated to routeSessions
  routeSessions: Record<string, string>  // route -> current session ID
  finishedSessions: string[]  // session IDs that are finished
  lastOutputTarget?: string  // last output target for auto-resume after restart
}

async function loadState(): Promise<SessionState> {
  const file = Bun.file(STATE_PATH)
  if (await file.exists()) {
    try {
      return await file.json() as SessionState
    } catch {
      // corrupted state, reset
    }
  }
  return { currentSessionId: null, routeSessions: {}, finishedSessions: [] }
}

async function saveState(state: SessionState): Promise<void> {
  await Bun.write(STATE_PATH, JSON.stringify(state, null, 2))
}

export async function ensureDataDirs(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true })
  await mkdir(join(TOEBEANS_DIR, 'knowledge'), { recursive: true })
  await mkdir(join(TOEBEANS_DIR, 'plugins'), { recursive: true })
  await mkdir(join(TOEBEANS_DIR, 'workspace'), { recursive: true })
}

function getSessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`)
}

// sanitize a route string for use in filenames
// "discord:1466679760976609393" -> "discord-1466679760976609393"
export function sanitizeRoute(route: string): string {
  return route.replace(/[^a-zA-Z0-9_-]/g, '-')
}

export async function generateSessionId(route?: string): Promise<string> {
  const today = new Date().toISOString().split('T')[0] // YYYY-MM-DD
  const routePrefix = route ? `${sanitizeRoute(route)}-` : ''
  const prefix = `${routePrefix}${today}-`

  const glob = new Bun.Glob('*.jsonl')
  const usedNumbers = new Set<number>()

  for await (const path of glob.scan(SESSIONS_DIR)) {
    const sessionId = path.replace('.jsonl', '')
    // only look at sessions with this prefix
    if (sessionId.startsWith(prefix)) {
      const numPart = sessionId.slice(prefix.length) // extract NNNN part
      const num = parseInt(numPart, 10)
      if (!isNaN(num) && num >= 0 && num <= 9999) {
        usedNumbers.add(num)
      }
    }
  }

  // find smallest unused number in range 0-9999
  for (let i = 0; i <= 9999; i++) {
    if (!usedNumbers.has(i)) {
      return `${prefix}${i.toString().padStart(4, '0')}`
    }
  }

  // all 10000 slots taken (unlikely)
  throw new Error(`all session IDs exhausted for ${prefix} (0000-9999)`)
}

export async function loadSession(sessionId: string): Promise<Message[]> {
  const path = getSessionPath(sessionId)
  const file = Bun.file(path)

  if (!(await file.exists())) {
    return []
  }

  const text = await file.text()
  const lines = text.trim().split('\n').filter(Boolean)

  return lines.map(line => JSON.parse(line) as Message)
}

export async function appendMessage(sessionId: string, message: Message): Promise<void> {
  const path = getSessionPath(sessionId)
  const line = JSON.stringify(message) + '\n'

  const file = Bun.file(path)
  if (await file.exists()) {
    const existing = await file.text()
    await Bun.write(path, existing + line)
  } else {
    await Bun.write(path, line)
  }
}

export async function listSessions(): Promise<SessionInfo[]> {
  const glob = new Bun.Glob('*.jsonl')
  const sessions: SessionInfo[] = []

  for await (const path of glob.scan(SESSIONS_DIR)) {
    const sessionId = path.replace('.jsonl', '')
    const fullPath = join(SESSIONS_DIR, path)
    const stat = await Bun.file(fullPath).stat()

    // use file creation time for both timestamps
    const createdAt = stat ? new Date(stat.birthtime) : new Date()
    const lastActiveAt = stat ? new Date(stat.mtime) : createdAt

    sessions.push({
      id: sessionId,
      createdAt,
      lastActiveAt,
    })
  }

  return sessions.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
}

export function getDataDir(): string {
  return TOEBEANS_DIR
}

export function getKnowledgeDir(): string {
  return join(TOEBEANS_DIR, 'knowledge')
}

export function getPluginsDir(): string {
  return join(TOEBEANS_DIR, 'plugins')
}

export function getWorkspaceDir(): string {
  return join(TOEBEANS_DIR, 'workspace')
}

export function getSoulPath(): string {
  return join(TOEBEANS_DIR, 'SOUL.md')
}

// get the current session for a route, creating one if needed
export async function getCurrentSessionId(route?: string): Promise<string> {
  const state = await loadState()

  // migrate legacy global session to default route
  if (state.currentSessionId && !state.routeSessions) {
    state.routeSessions = {}
  }

  const routeKey = route || '_default'

  // check route-specific session first
  const routeSession = state.routeSessions[routeKey]
  if (routeSession && !state.finishedSessions.includes(routeSession)) {
    return routeSession
  }

  // create new session for this route
  const newId = await generateSessionId(route)
  state.routeSessions[routeKey] = newId
  // keep legacy field in sync for backwards compat with external tools
  if (!route || route === '_default') {
    state.currentSessionId = newId
  }
  await saveState(state)
  return newId
}

// mark a session as finished (no new messages allowed)
export async function markSessionFinished(sessionId: string): Promise<void> {
  const state = await loadState()
  if (!state.finishedSessions.includes(sessionId)) {
    state.finishedSessions.push(sessionId)
  }
  if (state.currentSessionId === sessionId) {
    state.currentSessionId = null
  }
  // remove from any route mappings
  for (const [route, sid] of Object.entries(state.routeSessions)) {
    if (sid === sessionId) {
      delete state.routeSessions[route]
    }
  }
  await saveState(state)
}

export async function isSessionFinished(sessionId: string): Promise<boolean> {
  const state = await loadState()
  return state.finishedSessions.includes(sessionId)
}

// estimate token count for a session
export async function estimateSessionTokens(sessionId: string): Promise<number> {
  const messages = await loadSession(sessionId)
  const json = JSON.stringify(messages)
  return countTokens(json)
}

// get session creation time from file mtime (first message)
export async function getSessionCreatedAt(sessionId: string): Promise<Date | null> {
  const path = getSessionPath(sessionId)
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  // use file birthtime
  const stat = await file.stat()
  return stat ? new Date(stat.birthtime) : null
}

// get last activity time from file mtime
export async function getSessionLastActivity(sessionId: string): Promise<Date | null> {
  const path = getSessionPath(sessionId)
  const file = Bun.file(path)
  const stat = await file.stat()
  return stat ? new Date(stat.mtime) : null
}

// write a session from scratch (used for compacted sessions)
export async function writeSession(sessionId: string, messages: Message[]): Promise<void> {
  const path = getSessionPath(sessionId)
  const lines = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
  await Bun.write(path, lines)
}

// set the current session ID for a route (used after compaction)
export async function setCurrentSessionId(sessionId: string, route?: string): Promise<void> {
  const state = await loadState()
  const routeKey = route || '_default'
  if (!state.routeSessions) state.routeSessions = {}
  state.routeSessions[routeKey] = sessionId
  // keep legacy field in sync
  if (!route || route === '_default') {
    state.currentSessionId = sessionId
  }
  await saveState(state)
}

// set the last output target (for auto-resume after restart)
export async function setLastOutputTarget(outputTarget: string | null): Promise<void> {
  const state = await loadState()
  if (outputTarget) {
    state.lastOutputTarget = outputTarget
  } else {
    delete state.lastOutputTarget
  }
  await saveState(state)
}

// get the last output target
export async function getLastOutputTarget(): Promise<string | null> {
  const state = await loadState()
  return state.lastOutputTarget || null
}
