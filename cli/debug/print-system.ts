import { PluginManager } from '../../server/plugin.ts'
import { loadConfig } from '../../server/config.ts'
import { getSoulPath } from '../../server/session.ts'

export default async function printSystem() {
  const config = await loadConfig()

  // load soul
  const soulFile = Bun.file(getSoulPath())
  const soul = await soulFile.exists() ? await soulFile.text() : '(no soul file)'

  // set up plugins (skipInit — debug only needs descriptions)
  const pluginManager = new PluginManager()

  for (const [name, pluginConfig] of Object.entries(config.plugins)) {
    try {
      await pluginManager.loadPlugin(name, pluginConfig, { skipInit: true })
    } catch (err) {
      // silently skip
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
