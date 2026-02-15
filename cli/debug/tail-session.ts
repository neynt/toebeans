import { watch } from 'node:fs'
import { listSessions } from '../../server/session.ts'
import { homedir } from 'os'
import { join } from 'path'
import type { Message, ContentBlock, ToolResultContent, SessionEntry } from '../../server/types.ts'
import { formatLocalTime } from '../../server/time.ts'

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

// ── markdown rendering ──

function renderMarkdown(text: string): string {
  const lines = text.split('\n')
  const result: string[] = []
  let inCodeBlock = false
  let codeLang = ''

  for (const line of lines) {
    // fenced code blocks
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

    // headings
    const h1 = line.match(/^# (.+)/)
    if (h1) { result.push(`${BOLD}${FG_MAGENTA}# ${h1[1]}${RESET}`); continue }
    const h2 = line.match(/^## (.+)/)
    if (h2) { result.push(`${BOLD}${FG_BLUE}## ${h2[1]}${RESET}`); continue }
    const h3 = line.match(/^### (.+)/)
    if (h3) { result.push(`${BOLD}${FG_CYAN}### ${h3[1]}${RESET}`); continue }
    const h4 = line.match(/^#### (.+)/)
    if (h4) { result.push(`${BOLD}#### ${h4[1]}${RESET}`); continue }

    // horizontal rule
    if (/^[-*_]{3,}\s*$/.test(line)) {
      result.push(`${DIM}${'─'.repeat(64)}${RESET}`)
      continue
    }

    // blockquote
    if (line.startsWith('> ')) {
      result.push(`${DIM}│${RESET} ${FG_GRAY}${ITALIC}${renderInline(line.slice(2))}${RESET}`)
      continue
    }

    // unordered list
    const ul = line.match(/^(\s*)[*\-+] (.+)/)
    if (ul) {
      result.push(`${ul[1]}${FG_YELLOW}•${RESET} ${renderInline(ul[2]!)}`)
      continue
    }

    // ordered list
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
  // inline code (do first so inner patterns aren't matched)
  text = text.replace(/`([^`]+)`/g, `${FG_CYAN}$1${RESET}`)
  // bold+italic
  text = text.replace(/\*\*\*(.+?)\*\*\*/g, `${BOLD}${ITALIC}$1${RESET}`)
  // bold
  text = text.replace(/\*\*(.+?)\*\*/g, `${BOLD}$1${RESET}`)
  // italic
  text = text.replace(/\*(.+?)\*/g, `${ITALIC}$1${RESET}`)
  // strikethrough
  text = text.replace(/~~(.+?)~~/g, `${STRIKETHROUGH}$1${RESET}`)
  // links
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
    // show unescaped string — multiline gets its own indented block
    if (value.includes('\n')) {
      const lines = value.split('\n')
      return lines.map(line => `${indent}${line}`)
    }
    return [value]
  }

  if (Array.isArray(value)) {
    // short arrays inline
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
      // multiline string: key on its own line, then indented content
      lines.push(`${indent}${FG_MAGENTA}${key}${RESET}${DIM}:${RESET}`)
      lines.push(...rendered)
    } else if (rendered.length === 1 && rendered[0]!.length < INLINE_THRESHOLD) {
      // short value: same line
      lines.push(`${indent}${FG_MAGENTA}${key}${RESET}${DIM}:${RESET} ${rendered[0]}`)
    } else {
      // long or complex value: key then indented
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
      // show content, truncated if huge
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

function renderMessage(msg: Message, index: number): string {
  const roleColor = msg.role === 'user' ? BG_BLUE : BG_RED
  const roleLabel = msg.role === 'user'
    ? `${roleColor}${FG_WHITE}${BOLD} USER ${RESET}`
    : `${roleColor}${FG_WHITE}${BOLD} ASSISTANT ${RESET}`

  const header = `${roleLabel} ${DIM}#${index}${RESET}`
  const blocks = msg.content.map(b => renderContentBlock(b)).join('\n\n')

  return `${header}\n${blocks}`
}

// ── main ──

export default async function tailSession() {
  const sessionId = process.argv[3]

  if (!sessionId) {
    console.error('usage: bun run debug tail-session <session-id>')
    console.error('\nrecent sessions:')
    const sessions = await listSessions()
    sessions.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime())
    for (const s of sessions.slice(0, 10)) {
      console.error(`  ${s.id}  ${DIM}(${formatLocalTime(s.lastActiveAt)})${RESET}`)
    }
    process.exit(1)
  }

  const sessionPath = join(SESSIONS_DIR, `${sessionId}.jsonl`)
  const file = Bun.file(sessionPath)

  if (!(await file.exists())) {
    console.error(`session not found: ${sessionPath}`)
    process.exit(1)
  }

  // print existing messages
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

  function renderEntry(entry: SessionEntry): string {
    switch (entry.type) {
      case 'message': {
        const costStr = entry.cost
          ? `\n${DIM}── cost: $${(entry.cost.inputCost + entry.cost.outputCost).toFixed(4)} (in: ${entry.cost.usage.input} out: ${entry.cost.usage.output} cache_r: ${entry.cost.usage.cacheRead} cache_w: ${entry.cost.usage.cacheWrite}) ──${RESET}`
          : ''
        return renderMessage(entry.message, linesPrinted) + costStr
      }
      case 'system_prompt':
        return `${DIM}── system prompt (${entry.content.length} chars) ──${RESET}`
    }
  }

  function printNewMessages(text: string) {
    const lines = text.trim().split('\n').filter(Boolean)
    const newLines = lines.slice(linesPrinted)
    for (const line of newLines) {
      try {
        const entry = parseEntry(line)
        if (!entry) { linesPrinted++; continue }
        if (linesPrinted > 0) console.log() // blank line between entries
        console.log(renderEntry(entry))
      } catch {
        console.error(`${FG_RED}failed to parse line ${linesPrinted}${RESET}`)
      }
      linesPrinted++
    }
  }

  // initial read
  const initialText = await file.text()
  if (initialText.trim()) {
    printNewMessages(initialText)
  } else {
    console.log(`${DIM}(empty session, waiting for messages...)${RESET}`)
  }

  console.log(`\n${DIM}── tailing ${sessionId} ──${RESET}\n`)

  // watch for changes
  watch(sessionPath, async () => {
    try {
      const text = await Bun.file(sessionPath).text()
      printNewMessages(text)
    } catch {
      // file might be mid-write
    }
  })

  // keep alive
  await new Promise(() => {})
}
