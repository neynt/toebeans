import { PluginManager } from '../server/plugin.ts'
import { loadConfig } from '../server/config.ts'
import { loadSession, getSoulPath, listSessions } from '../server/session.ts'

// builtin plugin imports
import createBashPlugin from '../plugins/bash.ts'
import createMemoryPlugin from '../plugins/memory.ts'
import createPluginsPlugin from '../plugins/plugins.ts'
import createDiscordPlugin from '../plugins/discord.ts'
import createClaudeCodeTmuxPlugin from '../plugins/claude-code-tmux.ts'
import createTimersPlugin from '../plugins/timers.ts'

export default async function printLlmQuery() {
  const sessionId = process.argv[3]

  if (!sessionId) {
    console.error('usage: bun run debug print-llm-query <session-id>')
    console.error('\navailable sessions:')
    const sessions = await listSessions()
    for (const s of sessions.slice(0, 10)) {
      console.error(`  ${s.id}`)
    }
    process.exit(1)
  }

  const config = await loadConfig()

  // load soul
  const soulFile = Bun.file(getSoulPath())
  const soul = await soulFile.exists() ? await soulFile.text() : '(no soul file)'

  // set up plugins (mirrors server/index.ts)
  const pluginManager = new PluginManager()

  pluginManager.registerBuiltin('bash', createBashPlugin)
  pluginManager.registerBuiltin('memory', createMemoryPlugin)
  pluginManager.registerBuiltin('discord', createDiscordPlugin)
  pluginManager.registerBuiltin('claude-code-tmux', createClaudeCodeTmuxPlugin)
  pluginManager.registerBuiltin('timers', createTimersPlugin)
  pluginManager.registerBuiltin('plugins', () => createPluginsPlugin(pluginManager))

  // load configured plugins
  for (const [name, pluginConfig] of Object.entries(config.plugins)) {
    try {
      await pluginManager.loadPlugin(name, pluginConfig)
    } catch (err) {
      console.error(`warning: failed to load plugin ${name}:`, err)
    }
  }

  // build system prompt
  const systemParts: string[] = [soul, `Current working directory: ${process.cwd()}`]
  const pluginSection = pluginManager.getSystemPromptSection()
  if (pluginSection) {
    systemParts.push(pluginSection)
  }
  const system = systemParts.join('\n\n')

  // get tools
  const tools = pluginManager.getTools().map(t => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
  }))

  // load messages
  const messages = await loadSession(sessionId)

  const raw = {
    model: config.llm.model,
    max_tokens: 8192,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    messages,
    tools: tools.length > 0 ? tools : undefined,
  }
  console.log(JSON.stringify(raw, null, 2))
}
