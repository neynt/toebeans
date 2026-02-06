import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult } from '../../server/types.ts'
import { loadConfig, saveConfig } from '../../server/config.ts'

export default function createPluginsPlugin(): Plugin {
  return {
    name: 'plugins',
    description: `Plugin management:
- enable_plugin: Add a plugin to config and restart
- disable_plugin: Remove a plugin from config and restart`,

    tools: [
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
