import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult } from '../server/types.ts'
import type { PluginManager } from '../server/plugin.ts'
import { loadConfig, saveConfig } from '../server/config.ts'
import { getPluginsDir } from '../server/session.ts'

export default function createPluginsPlugin(pluginManager: PluginManager): Plugin {
  return {
    name: 'plugins',
    description: `Plugin management:
- list_plugins: See all plugins (available, visible, loaded)
- load_plugin: Activate a visible plugin for this session
- enable_plugin: Add a plugin to config (persistent, requires restart)
- disable_plugin: Remove a plugin from config`,

    tools: [
      {
        name: 'list_plugins',
        description: 'List all discovered plugins with their current state.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        async execute(): Promise<ToolResult> {
          const allPlugins = await pluginManager.discoverAllPlugins()
          const config = await loadConfig()
          const userDir = getPluginsDir()

          const lines: string[] = []

          for (const name of allPlugins.sort()) {
            const loaded = pluginManager.getPlugin(name)
            const inConfig = config.plugins[name]
            const isBuiltin = pluginManager.getBuiltinNames().includes(name)

            let state: string
            if (loaded) {
              state = loaded.state
            } else if (inConfig) {
              state = `configured (${inConfig.state}) but not loaded`
            } else {
              state = 'available'
            }

            const source = isBuiltin ? 'builtin' : `${userDir}/${name}.ts`
            lines.push(`${name}: ${state} [${source}]`)
          }

          return { content: lines.join('\n') || '(no plugins found)' }
        },
      },

      {
        name: 'load_plugin',
        description: 'Activate a plugin for this session, enabling its tools. Works on both visible and available plugins.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Name of the plugin to load' },
          },
          required: ['name'],
        },
        async execute(input: unknown): Promise<ToolResult> {
          const { name } = input as { name: string }

          // check if already loaded
          let loaded = pluginManager.getPlugin(name)

          if (loaded) {
            if (loaded.state === 'loaded') {
              return { content: `Plugin "${name}" is already loaded.` }
            }

            if (loaded.state === 'dormant') {
              return { content: `Plugin "${name}" is dormant and cannot be loaded.`, is_error: true }
            }

            // promote visible -> loaded
            pluginManager.setState(name, 'loaded')
          } else {
            // plugin not in memory - try to load it dynamically
            const allPlugins = await pluginManager.discoverAllPlugins()
            if (!allPlugins.includes(name)) {
              return {
                content: `Plugin "${name}" not found. Available: ${allPlugins.join(', ')}`,
                is_error: true,
              }
            }

            try {
              await pluginManager.loadPlugin(name, { state: 'loaded' })
              loaded = pluginManager.getPlugin(name)
            } catch (err) {
              return {
                content: `Failed to load plugin "${name}": ${err}`,
                is_error: true,
              }
            }
          }

          if (!loaded) {
            return { content: `Plugin "${name}" failed to load.`, is_error: true }
          }

          const plugin = loaded.plugin
          const toolNames = plugin.tools?.map(t => t.name).join(', ') || 'none'

          return {
            content: `Loaded plugin "${name}".\nTools: ${toolNames}\n\n${plugin.description || ''}`,
          }
        },
      },

      {
        name: 'enable_plugin',
        description: 'Add a plugin to config.json. Requires server restart to take effect.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Plugin name' },
            state: {
              type: 'string',
              enum: ['visible', 'loaded'],
              description: 'visible = can be loaded later, loaded = active on start',
            },
            config: {
              type: 'object',
              description: 'Plugin configuration (if needed)',
            },
          },
          required: ['name', 'state'],
        },
        async execute(input: unknown): Promise<ToolResult> {
          const { name, state, config: pluginConfig } = input as {
            name: string
            state: 'visible' | 'loaded'
            config?: Record<string, unknown>
          }

          // check if plugin exists
          const allPlugins = await pluginManager.discoverAllPlugins()
          if (!allPlugins.includes(name)) {
            return {
              content: `Plugin "${name}" not found. Available: ${allPlugins.join(', ')}`,
              is_error: true,
            }
          }

          const currentConfig = await loadConfig()
          currentConfig.plugins[name] = {
            state,
            config: pluginConfig ?? {},
          }
          await saveConfig(currentConfig)

          return {
            content: `Plugin "${name}" enabled with state "${state}". Restart server to apply.`,
          }
        },
      },

      {
        name: 'disable_plugin',
        description: 'Remove a plugin from config.json. Requires server restart.',
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
          if (!currentConfig.plugins[name]) {
            return {
              content: `Plugin "${name}" is not in config.`,
              is_error: true,
            }
          }

          delete currentConfig.plugins[name]
          await saveConfig(currentConfig)

          return { content: `Plugin "${name}" disabled. Restart server to apply.` }
        },
      },
    ],
  }
}
