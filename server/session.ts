import { mkdir } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import type { Message, SessionInfo } from './types.ts'

const DATA_DIR = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
const TOEBEANS_DIR = join(DATA_DIR, 'toebeans')
const SESSIONS_DIR = join(TOEBEANS_DIR, 'sessions')

export async function ensureDataDirs(): Promise<void> {
  await mkdir(SESSIONS_DIR, { recursive: true })
  await mkdir(join(TOEBEANS_DIR, 'knowledge'), { recursive: true })
  await mkdir(join(TOEBEANS_DIR, 'plugins'), { recursive: true })
}

function getSessionPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}.jsonl`)
}

export async function generateSessionId(): Promise<string> {
  const now = new Date()
  const date = now.toISOString().slice(0, 10) // YYYY-MM-DD

  // find existing sessions for today and get the next sequence number
  const glob = new Bun.Glob(`${date}-*.jsonl`)
  let maxSeq = -1
  for await (const path of glob.scan(SESSIONS_DIR)) {
    const match = path.match(new RegExp(`${date}-(\\d{4})\\.jsonl`))
    if (match?.[1]) {
      maxSeq = Math.max(maxSeq, parseInt(match[1], 10))
    }
  }

  const seq = String(maxSeq + 1).padStart(4, '0')
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

export function getSoulPath(): string {
  return join(TOEBEANS_DIR, 'SOUL.md')
}
