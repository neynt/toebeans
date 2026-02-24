import { loadConfig } from '../../server/config.ts'

// ── ANSI helpers ──

const RESET = '\x1b[0m'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'

const FG_CYAN = '\x1b[36m'
const FG_GREEN = '\x1b[32m'
const FG_MAGENTA = '\x1b[35m'
const FG_GRAY = '\x1b[90m'

const PLUGIN_COLORS = [
  '\x1b[36m', // cyan
  '\x1b[33m', // yellow
  '\x1b[32m', // green
  '\x1b[35m', // magenta
  '\x1b[34m', // blue
  '\x1b[91m', // bright red
  '\x1b[96m', // bright cyan
  '\x1b[93m', // bright yellow
]

interface ToolInfo {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

function renderSchema(schema: Record<string, unknown> | undefined, indent = 4): string {
  if (!schema) return ''
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined
  if (!props) return ''

  const required = new Set((schema.required as string[]) || [])
  const lines: string[] = []
  const pad = ' '.repeat(indent)

  for (const [key, prop] of Object.entries(props)) {
    const type = prop.type as string || 'any'
    const req = required.has(key)
    const desc = prop.description as string | undefined

    let line = `${pad}${FG_MAGENTA}${key}${RESET}`
    line += ` ${FG_GRAY}(${type}${req ? '' : ', optional'})${RESET}`
    if (desc) {
      line += ` ${DIM}${desc}${RESET}`
    }
    lines.push(line)
  }

  return lines.join('\n')
}

export default async function printTools() {
  const config = await loadConfig()
  const base = `http://localhost:${config.server.port}`

  const res = await fetch(`${base}/debug/tools`)
  if (!res.ok) {
    console.error(`server returned ${res.status} — is it running?`)
    process.exit(1)
  }

  const grouped = await res.json() as Record<string, ToolInfo[]>

  // validate shape — the old /debug/:sessionId endpoint would match "tools" as a session ID
  if (grouped && typeof grouped === 'object' && 'sessionId' in grouped) {
    console.error('server returned session debug data — restart the server to pick up the /debug/tools endpoint')
    process.exit(1)
  }

  const pluginNames = Object.keys(grouped)

  if (pluginNames.length === 0) {
    console.log(`${DIM}no tools loaded${RESET}`)
    return
  }

  let totalTools = 0
  for (const [i, pluginName] of pluginNames.entries()) {
    const color = PLUGIN_COLORS[i % PLUGIN_COLORS.length]
    const tools = grouped[pluginName]!
    totalTools += tools.length

    console.log(`\n${color}${BOLD}━━ ${pluginName} ${RESET}${color}${'━'.repeat(Math.max(0, 58 - pluginName.length))}${RESET}`)

    for (const tool of tools) {
      console.log(`\n  ${FG_CYAN}${BOLD}${tool.name}${RESET}`)
      console.log(`  ${tool.description}`)

      const params = renderSchema(tool.input_schema)
      if (params) {
        console.log(`  ${FG_GREEN}${DIM}params:${RESET}`)
        console.log(params)
      }
    }
  }

  console.log(`\n${DIM}${totalTools} tools across ${pluginNames.length} plugins${RESET}\n`)
}
