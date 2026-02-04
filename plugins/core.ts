import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult } from '../server/types.ts'
import type { PluginManager } from '../server/plugin.ts'

export default function createCorePlugin(pluginManager: PluginManager): Plugin {
  return {
    name: 'core',
    description: `Core plugin management:
- load_plugin(name): Load a plugin from visible to loaded state, enabling its full functionality`,

    tools: [
      {
        name: 'load_plugin',
        description: 'Load a visible plugin to enable its full functionality and tools.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name of the plugin to load' },
          },
          required: ['name'],
        },
        async execute(input: unknown): Promise<ToolResult> {
          const { name } = input as { name: string }

          const loaded = pluginManager.getPlugin(name)
          if (!loaded) {
            const visible = pluginManager.getVisiblePlugins()
            return {
              content: `Plugin "${name}" not found. Available plugins: ${visible.join(', ') || 'none'}`,
              is_error: true,
            }
          }

          if (loaded.state === 'loaded') {
            return { content: `Plugin "${name}" is already loaded.` }
          }

          if (loaded.state === 'dormant') {
            return { content: `Plugin "${name}" is dormant and cannot be loaded.`, is_error: true }
          }

          pluginManager.setState(name, 'loaded')

          const plugin = loaded.plugin
          const toolNames = plugin.tools?.map(t => t.name).join(', ') || 'none'

          return {
            content: `Loaded plugin "${name}".\nTools: ${toolNames}\n\n${plugin.description || ''}`,
          }
        },
      },
    ],
  }
}
