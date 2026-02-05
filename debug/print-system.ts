import { PluginManager } from '../server/plugin.ts'
import { loadConfig } from '../server/config.ts'
import { getSoulPath } from '../server/session.ts'

// builtin plugin imports
import createBashPlugin from '../plugins/bash.ts'
import createMemoryPlugin from '../plugins/memory.ts'
import createPluginsPlugin from '../plugins/plugins.ts'
import createDiscordPlugin from '../plugins/discord.ts'
import createClaudeCodeTmuxPlugin from '../plugins/claude-code-tmux.ts'
import createTimersPlugin from '../plugins/timers.ts'

export default async function printSystem() {
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
      // silently skip - discord will fail without token, etc.
    }
  }

  // build system prompt
  const systemParts: string[] = [soul, `Current working directory: ${process.cwd()}`]
  const pluginSection = pluginManager.getSystemPromptSection()
  if (pluginSection) {
    systemParts.push(pluginSection)
  }

  console.log(systemParts.join('\n\n'))
}
