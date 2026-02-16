import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { homedir } from 'os'
import { join, basename } from 'path'
import type { Message, ContentBlock, ToolResultContent, SessionEntry } from '../../server/types.ts'

const SESSIONS_DIR = join(homedir(), '.toebeans', 'sessions')

// ── ANSI helpers ──

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const ITALIC = '\x1b[3m'
const UNDERLINE = '\x1b[4m'
const STRIKETHROUGH = '\x1b[9m'

const FG_BLUE = '\x1b[34m'
const FG_CYAN = '\x1b[36m'
const FG_GREEN = '\x1b[32m'
const FG_YELLOW = '\x1b[33m'
const FG_RED = '\x1b[31m'
const FG_MAGENTA = '\x1b[35m'
const FG_WHITE = '\x1b[37m'
const FG_GRAY = '\x1b[90m'

const BG_RED = '\x1b[41m'
const BG_BLUE = '\x1b[44m'

// rotating colors for session prefixes
const SESSION_COLORS = [
  '\x1b[36m', // cyan
  '\x1b[33m', // yellow
  '\x1b[32m', // green
  '\x1b[35m', // magenta
  '\x1b[34m', // blue
  '\x1b[91m', // bright red
  '\x1b[96m', // bright cyan
  '\x1b[93m', // bright yellow
]

// ── markdown rendering (same as tail-session) ──

function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeLang = ''

  for (const line of lines) {
    if (line.trimStart().startsWith('```')) {
      if (!inCodeBlock) {
        inCodeBlock = true
        codeLang = line.trimStart().slice(3).trim()
        const label = codeLang ? ` ${codeLang} ` : ''
        result.push(`${DIM}┌──${label}${'─'.repeat(Math.max(0, 60 - label.length))}${RESET}`)
      } else {
        inCodeBlock = false
        codeLang = ''
        result.push(`${DIM}└${'─'.repeat(62)}${RESET}`)
      }
      continue
    }

    if (inCodeBlock) {
      result.push(`${DIM}│${RESET} ${FG_CYAN}${line}${RESET}`)
      continue
    }

    const h1 = line.match(/^# (.+)/)
    if (h1) { result.push(`${BOLD}${FG_MAGENTA}# ${h1[1]}${RESET}`); continue }
    const h2 = line.match(/^## (.+)/)
    if (h2) { result.push(`${BOLD}${FG_BLUE}## ${h2[1]}${RESET}`); continue }
    const h3 = line.match(/^### (.+)/)
    if (h3) { result.push(`${BOLD}${FG_CYAN}### ${h3[1]}${RESET}`); continue }
    const h4 = line.match(/^#### (.+)/)
    if (h4) { result.push(`${BOLD}#### ${h4[1]}${RESET}`); continue }

    if (/^[-*_]{3,}\s*$/.test(line)) {
      result.push(`${DIM}${'─'.repeat(64)}${RESET}`)
      continue
    }

    if (line.startsWith('> ')) {
      result.push(`${DIM}│${RESET} ${FG_GRAY}${ITALIC}${renderInline(line.slice(2))}${RESET}`)
      continue
    }

    const ul = line.match(/^(\s*)[*\-+] (.+)/)
    if (ul) {
      result.push(`${ul[1]}${FG_YELLOW}•${RESET} ${renderInline(ul[2]!)}`)
      continue
    }

    const ol = line.match(/^(\s*)(\d+)\. (.+)/)
    if (ol) {
      result.push(`${ol[1]}${FG_YELLOW}${ol[2]}.${RESET} ${renderInline(ol[3]!)}`)
      continue
    }

    result.push(renderInline(line))
  }

  return result.join('\n')
}

function renderInline(text: string): string {
  text = text.replace(/`([^`]+)`/g, `${FG_CYAN}$1${RESET}`)
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`)
  text = text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
  text = text.replace(/\*(.+?)\*/g, `${ITALIC}$1${RESET}`)
  text = text.replace(/~~(.+?)~~/g, `${STRIKETHROUGH}$1${RESET}`)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${UNDERLINE}${FG_BLUE}$1${RESET}${DIM} ($2)${RESET}`)
  return text
}

// ── content block rendering ──

function renderToolResultContent(content: ToolResultContent): string {
  if (typeof content === 'string') return content
  return content.map(block => {
    if (block.type === 'text') return block.text
    if (block.type === 'image') {
      const src = block.source
      if (src.type === 'url') return `[image: ${src.url}]`
      return `[image: ${src.media_type}, ${src.data.length} chars base64]`
    }
    return '[unknown block]'
  }).join('\n')
}

const INLINE_THRESHOLD = 80

function renderValue(value: unknown, indent: string): string[] {
  if (value === null) return [`${DIM}null${RESET}`]
  if (value === undefined) return [`${DIM}undefined${RESET}`]
  if (typeof value === 'boolean') return [`${FG_YELLOW}${value}${RESET}`]
  if (typeof value === 'number') return [`${FG_CYAN}${value}${RESET}`]

  if (typeof value === 'string') {
    if (value.includes('\n')) {
      const lines = value.split('\n')
      return lines.map(line => `${indent}${line}`)
    }
    return [value]
  }

  if (Array.isArray(value)) {
    const simple = value.every(v => typeof v !== 'object' || v === null)
    if (simple) {
      const inline = value.map(v =>
        typeof v === 'string' ? v : JSON.stringify(v)
      ).join(', ')
      if (inline.length < INLINE_THRESHOLD) return [`[${inline}]`]
    }
    const lines: string[] = []
    for (const item of value) {
      const rendered = renderValue(item, indent + '  ')
      lines.push(`${indent}${FG_YELLOW}-${RESET} ${rendered[0]}`)
      lines.push(...rendered.slice(1))
    }
    return lines
  }

  if (typeof value === 'object') {
    return renderParams(value as Record<string, unknown>, indent)
  }

  return [String(value)]
}

function renderParams(obj: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const rendered = renderValue(value, indent + '  ')

    if (typeof value === 'string' && value.includes('\n')) {
      lines.push(`${indent}${FG_MAGENTA}${key}${RESET}${DIM}:${RESET}`)
      lines.push(...rendered)
    } else if (rendered.length === 1 && rendered[0]!.length < INLINE_THRESHOLD) {
      lines.push(`${indent}${FG_MAGENTA}${key}${RESET}${DIM}:${RESET} ${rendered[0]}`)
    } else {
      lines.push(`${indent}${FG_MAGENTA}${key}${RESET}${DIM}:${RESET}`)
      lines.push(...rendered)
    }
  }
  return lines
}

function renderContentBlock(block: ContentBlock): string {
  switch (block.type) {
    case 'text':
      return renderMarkdown(block.text)

    case 'image': {
      const src = block.source
      if (src.type === 'url') {
        return `${DIM}[image: ${src.url}]${RESET}`
      }
      return `${DIM}[image: ${src.media_type}, ${src.data.length} chars base64]${RESET}`
    }

    case 'tool_use': {
      const lines = [
        `${FG_YELLOW}${BOLD}⚙ ${block.name}${RESET} ${DIM}(${block.id})${RESET}`,
      ]
      if (typeof block.input === 'string') {
        lines.push(`  ${DIM}${block.input}${RESET}`)
      } else if (block.input && typeof block.input === 'object') {
        lines.push(...renderParams(block.input as Record<string, unknown>, '  '))
      }
      return lines.join('\n')
    }

    case 'tool_result': {
      const content = renderToolResultContent(block.content)
      const errorTag = block.is_error ? `${BG_RED}${FG_WHITE} ERROR ${RESET} ` : ''
      const lines = [
        `${FG_GREEN}${BOLD}← result${RESET} ${errorTag}${DIM}(${block.tool_use_id})${RESET}`,
      ]
      const contentLines = content.split('\n')
      const MAX_LINES = 50
      const shown = contentLines.slice(0, MAX_LINES)
      for (const line of shown) {
        lines.push(`  ${DIM}${line}${RESET}`)
      }
      if (contentLines.length > MAX_LINES) {
        lines.push(`  ${DIM}... (${contentLines.length - MAX_LINES} more lines, ${content.length} chars total)${RESET}`)
      }
      return lines.join('\n')
    }

    default:
      return `${DIM}[unknown block type: ${(block as any).type}]${RESET}`
  }
}

// ── per-session tailer ──

interface SessionTailer {
  sessionId: string
  color: string
  linesPrinted: number
  watcher: FSWatcher
}

const tailers = new Map<string, SessionTailer>()
let colorIndex = 0

function prefixLines(text: string, prefix: string): string {
  return text.split('\n').map(line => `${prefix} ${line}`).join('\n')
}

async function startTailing(sessionId: string, filePath: string, seed = true) {
  if (tailers.has(sessionId)) return

  const color = SESSION_COLORS[colorIndex % SESSION_COLORS.length]!
  colorIndex++

  const prefix = `${color}${BOLD}[${sessionId}]${RESET}`
  console.log(`${DIM}── now tailing ${color}${sessionId}${RESET}${DIM} ──${RESET}`)

  let linesPrinted = 0

  function parseEntry(line: string): SessionEntry | null {
    const parsed = JSON.parse(line)
    if (parsed.type === 'system_prompt' || parsed.type === 'message') {
      return parsed as SessionEntry
    }
    // legacy: standalone cost entries — skip
    if (parsed.type === 'cost') return null
    // legacy: raw Message object
    return { type: 'message', timestamp: '', message: parsed as Message }
  }

  async function printNewMessages() {
    try {
      const text = await Bun.file(filePath).text()
      const lines = text.trim().split('\n').filter(Boolean)
      const newLines = lines.slice(linesPrinted)
      for (const line of newLines) {
        try {
          const entry = parseEntry(line)
          if (!entry) { linesPrinted++; continue }

          if (entry.type === 'message') {
            const msg = entry.message
            const roleColor = msg.role === 'user' ? BG_BLUE : BG_RED
            const roleLabel = msg.role === 'user'
              ? `${roleColor}${FG_WHITE}${BOLD} USER ${RESET}`
              : `${roleColor}${FG_WHITE}${BOLD} ASSISTANT ${RESET}`

            const costStr = entry.cost
              ? ` ${DIM}($${(entry.cost.inputCost + entry.cost.outputCost).toFixed(4)})${RESET}`
              : ''
            const header = `${prefix} ${roleLabel} ${DIM}#${linesPrinted}${RESET}${costStr}`
            const blocks = msg.content.map(b => renderContentBlock(b)).join('\n\n')
            const prefixed = prefixLines(blocks, prefix)

            if (linesPrinted > 0) console.log()
            console.log(header)
            console.log(prefixed)
          } else if (entry.type === 'system_prompt') {
            console.log(`${prefix} ${DIM}── system prompt (${entry.content.length} chars) ──${RESET}`)
          }
        } catch {
          console.error(`${prefix} ${FG_RED}failed to parse line ${linesPrinted}${RESET}`)
        }
        linesPrinted++
      }
    } catch {
      // file might be mid-write
    }
  }

  // print existing content (only if seeding), otherwise skip to end
  if (seed) {
    await printNewMessages()
  } else {
    try {
      const text = await Bun.file(filePath).text()
      linesPrinted = text.trim().split('\n').filter(Boolean).length
    } catch {}
  }

  // watch for new content
  const watcher = watch(filePath, () => { printNewMessages() })
  tailers.set(sessionId, { sessionId, color, linesPrinted, watcher })
}

function sessionIdFromFilename(filename: string): string {
  return basename(filename, '.jsonl')
}

// ── main ──

export default async function tailAllSessions() {
  console.log(`${BOLD}tailing all sessions in ${SESSIONS_DIR}${RESET}\n`)

  // start tailing all existing .jsonl files, sorted by mtime (most recent first)
  const files = await readdir(SESSIONS_DIR)
  const jsonlFiles = files.filter(f => f.endsWith('.jsonl'))

  const withMtime = await Promise.all(
    jsonlFiles.map(async f => {
      const s = await stat(join(SESSIONS_DIR, f))
      return { file: f, mtime: s.mtimeMs }
    })
  )
  withMtime.sort((a, b) => b.mtime - a.mtime)

  for (let i = 0; i < withMtime.length; i++) {
    const { file } = withMtime[i]!
    const sessionId = sessionIdFromFilename(file)
    await startTailing(sessionId, join(SESSIONS_DIR, file), i === 0)
  }

  if (jsonlFiles.length === 0) {
    console.log(`${DIM}(no sessions yet, waiting for new ones...)${RESET}`)
  }

  // watch directory for new session files
  watch(SESSIONS_DIR, (_event, filename) => {
    if (!filename || !filename.endsWith('.jsonl')) return
    const sessionId = sessionIdFromFilename(filename)
    if (!tailers.has(sessionId)) {
      console.log(`\n${FG_GREEN}${BOLD}+ new session:${RESET} ${sessionId}`)
      startTailing(sessionId, join(SESSIONS_DIR, filename))
    }
  })

  // keep alive
  await new Promise(() => {})
}
