import { countTokens } from '@anthropic-ai/tokenizer'
import { join } from 'path'
import { homedir } from 'os'

const DATA_DIR = join(homedir(), '.toebeans')
const KNOWLEDGE_DIR = join(DATA_DIR, 'knowledge')
const SOUL_PATH = join(DATA_DIR, 'SOUL.md')

interface Component {
  name: string
  text: string
  tokens: number
}

async function readFileOrNull(path: string): Promise<string | null> {
  const f = Bun.file(path)
  return (await f.exists()) ? await f.text() : null
}

async function getToolSchemas() {
  const tools: { name: string; description: string; input_schema: unknown }[] = []

  const configRaw = await Bun.file(join(DATA_DIR, 'config.json')).json() as any
  const enabledPlugins = Object.keys(configRaw.plugins || {})

  const builtinDir = join(import.meta.dir, '..', '..', 'plugins')
  const userPluginDir = join(DATA_DIR, 'plugins')

  for (const pluginName of enabledPlugins) {
    let pluginPath = join(builtinDir, pluginName, 'index.ts')
    let f = Bun.file(pluginPath)
    if (!(await f.exists())) {
      pluginPath = join(userPluginDir, pluginName, 'index.ts')
      f = Bun.file(pluginPath)
      if (!(await f.exists())) continue
    }

    try {
      const mod = await import(pluginPath)
      const createFn = mod.default
      if (typeof createFn !== 'function') continue

      let plugin: any
      try {
        plugin = createFn()
      } catch {
        continue
      }

      if (plugin?.tools) {
        for (const tool of plugin.tools) {
          tools.push({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
          })
        }
      }
    } catch {
      // plugin import failed, skip
    }
  }

  return tools
}

export default async function analyzeSystem() {
  const components: Component[] = []

  // 1. SOUL.md
  const soul = await readFileOrNull(SOUL_PATH)
    ?? await Bun.file(new URL('../../server/default-soul.md', import.meta.url)).text()
  components.push({ name: 'SOUL.md', text: soul, tokens: countTokens(soul) })

  // 2. Memory plugin: USER.md
  const userKnowledge = await readFileOrNull(join(KNOWLEDGE_DIR, 'USER.md'))
  if (userKnowledge?.trim()) {
    components.push({ name: 'USER.md (knowledge)', text: userKnowledge, tokens: countTokens(userKnowledge) })
  }

  // 3. Memory plugin: recent daily logs (2 days by default)
  const recentLogDays = 2
  const today = new Date()
  const logParts: string[] = []
  for (let i = 0; i < recentLogDays; i++) {
    const d = new Date(today)
    d.setDate(d.getDate() - i)
    const dateStr = d.toISOString().slice(0, 10)
    const content = await readFileOrNull(join(KNOWLEDGE_DIR, `${dateStr}.md`))
    if (content?.trim()) {
      logParts.push(content)
    }
  }
  if (logParts.length > 0) {
    const recentActivity = '## Recent Activity\n\n' + logParts.join('\n\n')
    components.push({ name: 'Recent daily logs', text: recentActivity, tokens: countTokens(recentActivity) })
  }

  // 4. Working directory context
  const workdirText = `Current working directory: ${process.cwd()}`
  components.push({ name: 'Working directory', text: workdirText, tokens: countTokens(workdirText) })

  // 5. Plugin descriptions
  const configRaw = await Bun.file(join(DATA_DIR, 'config.json')).json() as any
  const enabledPlugins = Object.keys(configRaw.plugins || {})

  const builtinDir = join(import.meta.dir, '..', '..', 'plugins')
  const userPluginDir = join(DATA_DIR, 'plugins')

  const pluginDescriptions: { name: string; desc: string }[] = []
  for (const pluginName of enabledPlugins) {
    let pluginPath = join(builtinDir, pluginName, 'index.ts')
    let f = Bun.file(pluginPath)
    if (!(await f.exists())) {
      pluginPath = join(userPluginDir, pluginName, 'index.ts')
      f = Bun.file(pluginPath)
      if (!(await f.exists())) continue
    }

    try {
      const mod = await import(pluginPath)
      const createFn = mod.default
      if (typeof createFn !== 'function') continue

      let plugin: any
      try {
        plugin = createFn()
      } catch {
        continue
      }

      if (plugin?.description) {
        pluginDescriptions.push({ name: pluginName, desc: plugin.description })
      }
    } catch {
      // skip
    }
  }

  const pluginSectionText = pluginDescriptions.map(p => `## ${p.name}\n${p.desc}`).join('\n\n')
  components.push({ name: 'Plugin descriptions section', text: pluginSectionText, tokens: countTokens(pluginSectionText) })

  for (const p of pluginDescriptions) {
    const text = `## ${p.name}\n${p.desc}`
    components.push({ name: `  \u2514 ${p.name}`, text, tokens: countTokens(text) })
  }

  // compute total system prompt
  const systemParts = [soul]
  const memoryPromptParts: string[] = []
  if (userKnowledge?.trim()) memoryPromptParts.push(userKnowledge)
  if (logParts.length > 0) {
    memoryPromptParts.push('## Recent Activity\n\n' + logParts.join('\n\n'))
  }
  if (memoryPromptParts.length > 0) {
    systemParts.push(memoryPromptParts.join('\n\n'))
  }
  systemParts.push(workdirText)
  if (pluginSectionText) systemParts.push(pluginSectionText)

  const fullPrompt = systemParts.join('\n\n')
  const totalTokens = countTokens(fullPrompt)

  // tool definitions
  const toolSchemas = await getToolSchemas()
  const toolsJson = JSON.stringify(toolSchemas)
  const toolTokens = countTokens(toolsJson)

  // print results
  console.log('\n\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557')
  console.log('\u2551           SYSTEM PROMPT TOKEN BREAKDOWN                     \u2551')
  console.log('\u255a\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255d\n')

  const mainComponents = components.filter(c => !c.name.startsWith('  \u2514'))
  const subComponents = components.filter(c => c.name.startsWith('  \u2514'))

  mainComponents.sort((a, b) => b.tokens - a.tokens)

  const maxNameLen = Math.max(...components.map(c => c.name.length))

  for (const c of mainComponents) {
    const pct = ((c.tokens / totalTokens) * 100).toFixed(1)
    const bar = '\u2588'.repeat(Math.round(c.tokens / totalTokens * 30))
    console.log(`${c.name.padEnd(maxNameLen)}  ${String(c.tokens).padStart(6)} tokens  ${pct.padStart(5)}%  ${bar}`)

    if (c.name === 'Plugin descriptions section') {
      subComponents.sort((a, b) => b.tokens - a.tokens)
      for (const s of subComponents) {
        console.log(`${s.name.padEnd(maxNameLen)}  ${String(s.tokens).padStart(6)} tokens`)
      }
    }
  }

  console.log(`${'\u2500'.repeat(maxNameLen + 30)}`)
  console.log(`${'SYSTEM PROMPT TOTAL'.padEnd(maxNameLen)}  ${String(totalTokens).padStart(6)} tokens`)
  console.log(`${'(full prompt chars)'.padEnd(maxNameLen)}  ${String(fullPrompt.length).padStart(6)} chars`)
  console.log()

  console.log(`${'Tool definitions (JSON)'.padEnd(maxNameLen)}  ${String(toolTokens).padStart(6)} tokens  (${toolSchemas.length} tools)`)

  const toolBreakdown = toolSchemas.map(t => {
    const json = JSON.stringify(t)
    return { name: t.name, tokens: countTokens(json) }
  }).sort((a, b) => b.tokens - a.tokens)

  for (const t of toolBreakdown) {
    console.log(`  \u2514 ${t.name.padEnd(maxNameLen - 4)}  ${String(t.tokens).padStart(6)} tokens`)
  }

  console.log()
  console.log(`${'TOTAL CONTEXT OVERHEAD'.padEnd(maxNameLen)}  ${String(totalTokens + toolTokens).padStart(6)} tokens`)
  console.log()
}
