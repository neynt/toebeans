import { mkdir, unlink } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Message, SessionInfo, SessionEntry } from './types.ts'
import { countMessagesTokens } from './tokens.ts'

const TOEBEANS_DIR = join(homedir(), '.toebeans')
const SESSIONS_DIR = join(TOEBEANS_DIR, 'sessions')
const RESUME_PATH = join(TOEBEANS_DIR, 'resume.json')

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

/**
 * Parse a JSONL line as a SessionEntry. Handles both new entry format
 * (has a `type` field) and legacy format (raw Message objects with `role`).
 */
function parseSessionLine(line: string): SessionEntry {
  const parsed = JSON.parse(line)
  if (parsed.type === 'system_prompt' || parsed.type === 'message' || parsed.type === 'cost') {
    return parsed as SessionEntry
  }
  // legacy: raw Message object — wrap it
  return { type: 'message', timestamp: '', message: parsed as Message }
}

/**
 * Load all session entries (new format).
 */
export async function loadSessionEntries(sessionId: string): Promise<SessionEntry[]> {
  const path = getSessionPath(sessionId)
  const file = Bun.file(path)

  if (!(await file.exists())) {
    return []
  }

  const text = await file.text()
  const lines = text.trim().split('\n').filter(Boolean)
  return lines.map(parseSessionLine)
}

/**
 * Load only the Message objects from a session (for LLM calls).
 */
export async function loadSession(sessionId: string): Promise<Message[]> {
  const entries = await loadSessionEntries(sessionId)
  return entries
    .filter((e): e is SessionEntry & { type: 'message' } => e.type === 'message')
    .map(e => e.message)
}

/**
 * Load the system prompt from a session (first system_prompt entry), or null if none.
 */
export async function loadSystemPrompt(sessionId: string): Promise<string | null> {
  const entries = await loadSessionEntries(sessionId)
  const sp = entries.find((e): e is SessionEntry & { type: 'system_prompt' } => e.type === 'system_prompt')
  return sp?.content ?? null
}

/**
 * Load all cost entries from a session.
 */
export async function loadCostEntries(sessionId: string): Promise<(SessionEntry & { type: 'cost' })[]> {
  const entries = await loadSessionEntries(sessionId)
  return entries.filter((e): e is SessionEntry & { type: 'cost' } => e.type === 'cost')
}

/**
 * Append a session entry to the JSONL file.
 */
export async function appendEntry(sessionId: string, entry: SessionEntry): Promise<void> {
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

/**
 * Append a message to the session (wraps in a SessionEntry).
 */
export async function appendMessage(sessionId: string, message: Message): Promise<void> {
  await appendEntry(sessionId, {
    type: 'message',
    timestamp: new Date().toISOString(),
    message,
  })
}

export async function listSessions(): Promise<SessionInfo[]> {
  const glob = new Bun.Glob('*.jsonl')
  const sessions: SessionInfo[] = []

  for await (const path of glob.scan(SESSIONS_DIR)) {
    const sessionId = path.replace('.jsonl', '')
    const fullPath = join(SESSIONS_DIR, path)
    const stat = await Bun.file(fullPath).stat()

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

// get the current session for a route by finding the most recently modified session file
export async function getCurrentSessionId(route?: string): Promise<string> {
  const routePrefix = route ? `${sanitizeRoute(route)}-` : ''

  const glob = new Bun.Glob('*.jsonl')
  let latestId: string | null = null
  let latestMtime = 0

  for await (const path of glob.scan(SESSIONS_DIR)) {
    const sessionId = path.replace('.jsonl', '')

    if (routePrefix) {
      // routed session: must start with the prefix
      if (!sessionId.startsWith(routePrefix)) continue
    } else {
      // default route: must start with a digit (date-prefixed, no route)
      if (!/^\d/.test(sessionId)) continue
    }

    const stat = await Bun.file(join(SESSIONS_DIR, path)).stat()
    if (stat && stat.mtimeMs > latestMtime) {
      latestMtime = stat.mtimeMs
      latestId = sessionId
    }
  }

  if (latestId) return latestId

  // no session found, create a new ID
  return await generateSessionId(route)
}

// estimate token count for a session
export async function estimateSessionTokens(sessionId: string): Promise<number> {
  const messages = await loadSession(sessionId)
  return countMessagesTokens(messages)
}

// get session creation time from file birthtime
export async function getSessionCreatedAt(sessionId: string): Promise<Date | null> {
  const path = getSessionPath(sessionId)
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  const stat = await file.stat()
  return stat ? new Date(stat.birthtime) : null
}

// get last activity time from file mtime
export async function getSessionLastActivity(sessionId: string): Promise<Date | null> {
  const path = getSessionPath(sessionId)
  const file = Bun.file(path)
  if (!(await file.exists())) return null
  const stat = await file.stat()
  return stat ? new Date(stat.mtime) : null
}

// write a session from scratch (used for compacted sessions)
export async function writeSession(sessionId: string, entries: SessionEntry[]): Promise<void> {
  const path = getSessionPath(sessionId)
  const lines = entries.map(e => JSON.stringify(e)).join('\n') + '\n'
  await Bun.write(path, lines)
}

// set the last output target (for auto-resume after restart)
export async function setLastOutputTarget(outputTarget: string | null): Promise<void> {
  if (outputTarget) {
    await Bun.write(RESUME_PATH, JSON.stringify({ outputTarget }))
  } else {
    try { await unlink(RESUME_PATH) } catch { /* doesn't exist */ }
  }
}

// get the last output target
export async function getLastOutputTarget(): Promise<string | null> {
  const file = Bun.file(RESUME_PATH)
  if (!(await file.exists())) return null
  try {
    const data = await file.json() as { outputTarget?: string }
    return data.outputTarget || null
  } catch {
    return null
  }
}
