import { mkdir } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Message, SessionInfo } from './types.ts'

const TOEBEANS_DIR = join(homedir(), '.toebeans')
const SESSIONS_DIR = join(TOEBEANS_DIR, 'sessions')
const STATE_PATH = join(TOEBEANS_DIR, 'state.json')

// rough estimate: 4 chars per token
const CHARS_PER_TOKEN = 4

interface SessionState {
  currentSessionId: string | null
  finishedSessions: string[]  // session IDs that are finished
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
  return { currentSessionId: null, finishedSessions: [] }
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

export async function generateSessionId(): Promise<string> {
  const now = new Date()
  const date = now.toISOString().slice(0, 10) // YYYY-MM-DD
  // use random 4-digit suffix to avoid conflicts without scanning files
  const seq = String(Math.floor(Math.random() * 10000)).padStart(4, '0')
  return `${date}-${seq}`
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

    // parse date from session ID (YYYY-MM-DD-XXXX)
    const datePart = sessionId.slice(0, 10)
    const createdAt = new Date(datePart)

    sessions.push({
      id: sessionId,
      createdAt,
      lastActiveAt: stat ? new Date(stat.mtime) : createdAt,
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

// get the current main session, creating one if needed
export async function getCurrentSessionId(): Promise<string> {
  const state = await loadState()

  if (state.currentSessionId && !state.finishedSessions.includes(state.currentSessionId)) {
    return state.currentSessionId
  }

  // create new session
  const newId = await generateSessionId()
  state.currentSessionId = newId
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
  return Math.ceil(json.length / CHARS_PER_TOKEN)
}

// get session creation time from file mtime (first message)
export async function getSessionCreatedAt(sessionId: string): Promise<Date | null> {
  const path = getSessionPath(sessionId)
  const file = Bun.file(path)
  if (!(await file.exists())) return null

  // parse date from session ID if it matches pattern
  const match = sessionId.match(/^(\d{4}-\d{2}-\d{2})/)
  if (match) {
    return new Date(match[1]!)
  }

  // fallback to file birthtime
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

// set the current session ID (used after compaction)
export async function setCurrentSessionId(sessionId: string): Promise<void> {
  const state = await loadState()
  state.currentSessionId = sessionId
  await saveState(state)
}
