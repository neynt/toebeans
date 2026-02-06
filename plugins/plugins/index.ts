import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult } from '../../server/types.ts'
import { loadConfig, saveConfig } from '../../server/config.ts'
import { getPluginsDir } from '../../server/session.ts'
import { join } from 'path'
import { mkdir } from 'node:fs/promises'

const TEMPLATE_PATH = new URL('../template/index.ts', import.meta.url).pathname

export default function createPluginsPlugin(): Plugin {
  return {
    name: 'plugins',
    description: `Create, enable, and disable plugins. User plugins live in ~/.toebeans/plugins/.`,

    tools: [
      {
        name: 'create_plugin',
        description: 'Create a new plugin skeleton in ~/.toebeans/plugins/<name>/. Use spawn_claude_code to implement it afterward.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Plugin name (kebab-case)' },
          },
          required: ['name'],
        },
        async execute(input: unknown): Promise<ToolResult> {
          const { name } = input as { name: string }
          const pluginDir = join(getPluginsDir(), name)
          const indexPath = join(pluginDir, 'index.ts')

          const file = Bun.file(indexPath)
          if (await file.exists()) {
            return { content: `Plugin "${name}" already exists at ${pluginDir}`, is_error: true }
          }

          await mkdir(pluginDir, { recursive: true })
          const template = await Bun.file(TEMPLATE_PATH).text()
          const content = template.replaceAll('template', name)
          await Bun.write(indexPath, content)

          return {
            content: `Plugin scaffolded at ${pluginDir}/index.ts\n\nUse spawn_claude_code to implement it, then enable_plugin to activate it.`,
          }
        },
      },
      {
        name: 'enable_plugin',
        description: 'Enable a plugin by adding it to config and restarting the server.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Plugin name' },
            config: { type: 'object', description: 'Plugin configuration (optional)' },
          },
          required: ['name'],
        },
        async execute(input: unknown): Promise<ToolResult> {
          const { name, config: pluginConfig } = input as { name: string; config?: Record<string, unknown> }
          const currentConfig = await loadConfig()
          currentConfig.plugins[name] = pluginConfig ?? {}
          await saveConfig(currentConfig)
          console.log(`enable_plugin: enabled ${name}, restarting...`)
          setTimeout(() => process.exit(0), 100)
          return { content: `Enabled plugin "${name}". Server is restarting...` }
        },
      },
      {
        name: 'disable_plugin',
        description: 'Disable a plugin by removing it from config and restarting the server.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Plugin name to disable' },
          },
          required: ['name'],
        },
        async execute(input: unknown): Promise<ToolResult> {
          const { name } = input as { name: string }
          const currentConfig = await loadConfig()
          if (!(name in currentConfig.plugins)) {
            return { content: `Plugin "${name}" is not enabled.`, is_error: true }
          }
          delete currentConfig.plugins[name]
          await saveConfig(currentConfig)
          console.log(`disable_plugin: disabled ${name}, restarting...`)
          setTimeout(() => process.exit(0), 100)
          return { content: `Disabled plugin "${name}". Server is restarting...` }
        },
      },
    ],
  }
}
