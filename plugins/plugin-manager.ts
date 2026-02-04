import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult } from '../server/types.ts'
import { loadConfig, saveConfig } from '../server/config.ts'

interface PluginField {
  name: string
  description: string
  required: boolean
  secret?: boolean
}

interface PluginInfo {
  description: string
  fields: PluginField[]
}

// registry of builtin plugins and their config requirements
const PLUGIN_REGISTRY: Record<string, PluginInfo> = {
  discord: {
    description: 'Discord bot integration for sending/reading messages and reacting to conversations.',
    fields: [
      { name: 'token', description: 'Discord bot token from Discord Developer Portal', required: true, secret: true },
      { name: 'channels', description: 'Array of channel IDs to listen to (empty array = all accessible channels)', required: false },
      { name: 'respondToMentions', description: 'If true, only respond when the bot is @mentioned in guild channels', required: false },
      { name: 'allowDMs', description: 'If true (default), respond to direct messages', required: false },
    ],
  },
  tools: {
    description: 'File system and shell tools (read, write, bash, etc.).',
    fields: [
      { name: 'allowBash', description: 'Allow bash command execution', required: false },
    ],
  },
  memory: {
    description: 'Knowledge base - save and recall information across sessions.',
    fields: [],
  },
  'write-plugin': {
    description: 'Create custom plugins at runtime.',
    fields: [],
  },
  core: {
    description: 'Core plugin management (load_plugin tool).',
    fields: [],
  },
  'claude-code': {
    description: 'Control Claude Code instances via tmux. Recursive fun.',
    fields: [],
  },
  'plugin-manager': {
    description: 'Meta-plugin for enabling/disabling other plugins via config.json.',
    fields: [],
  },
}

export default function createPluginManagerPlugin(): Plugin {
  const tools: Tool[] = [
    {
      name: 'list_plugins',
      description: 'List all available plugins with their current state and whether they need configuration.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<ToolResult> {
        const config = await loadConfig()
        const lines: string[] = ['Available plugins:\n']

        for (const [name, info] of Object.entries(PLUGIN_REGISTRY)) {
          const pluginConfig = config.plugins[name]
          const state = pluginConfig?.state ?? 'not configured'
          const needsConfig = info.fields.some(f => f.required)

          lines.push(`- ${name}: ${state}${needsConfig ? ' (requires configuration)' : ''}`)
          lines.push(`  ${info.description}`)
        }

        return { content: lines.join('\n') }
      },
    },
    {
      name: 'get_plugin_requirements',
      description: 'Get the configuration requirements for a specific plugin. Call this before enabling a plugin to know what information to ask the user for.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin name' },
        },
        required: ['name'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { name } = input as { name: string }
        const info = PLUGIN_REGISTRY[name]

        if (!info) {
          return {
            content: `Unknown plugin: "${name}". Use list_plugins to see available plugins.`,
            is_error: true,
          }
        }

        if (info.fields.length === 0) {
          return {
            content: `Plugin "${name}" requires no configuration. You can enable it directly with enable_plugin.`,
          }
        }

        const lines: string[] = [`Configuration for "${name}":\n`]
        for (const field of info.fields) {
          const req = field.required ? '(required)' : '(optional)'
          const secret = field.secret ? ' [secret - ask user privately]' : ''
          lines.push(`- ${field.name} ${req}${secret}: ${field.description}`)
        }

        lines.push('\nIMPORTANT: Ask the user for ALL required fields before calling enable_plugin.')
        if (info.fields.some(f => f.secret)) {
          lines.push('For secret fields like API tokens, remind the user not to share them publicly.')
        }

        return { content: lines.join('\n') }
      },
    },
    {
      name: 'enable_plugin',
      description: 'Enable a plugin by adding it to config.json. The server must be restarted for changes to take effect. Make sure you have gathered all required configuration from the user first!',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Plugin name' },
          state: {
            type: 'string',
            enum: ['visible', 'loaded'],
            description: 'Plugin state: "visible" (can be loaded later) or "loaded" (active immediately)',
          },
          config: {
            type: 'object',
            description: 'Plugin configuration object with the required fields',
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

        const info = PLUGIN_REGISTRY[name]
        if (!info) {
          return {
            content: `Unknown plugin: "${name}". Use list_plugins to see available plugins.`,
            is_error: true,
          }
        }

        // validate required fields
        const missingFields: string[] = []
        for (const field of info.fields) {
          if (field.required && (!pluginConfig || pluginConfig[field.name] === undefined)) {
            missingFields.push(field.name)
          }
        }

        if (missingFields.length > 0) {
          return {
            content: `Missing required configuration fields: ${missingFields.join(', ')}.\nUse get_plugin_requirements("${name}") to see what's needed, then ask the user for these values.`,
            is_error: true,
          }
        }

        // load current config, update it, save it
        const currentConfig = await loadConfig()
        currentConfig.plugins[name] = {
          state,
          config: pluginConfig ?? {},
        }
        await saveConfig(currentConfig)

        return {
          content: `Plugin "${name}" has been enabled with state "${state}".\n\n` +
            `IMPORTANT: The server must be restarted for this change to take effect.\n` +
            `Tell the user to restart the toebeans server (Ctrl+C and run \`bun run server\` again).`,
        }
      },
    },
    {
      name: 'disable_plugin',
      description: 'Disable a plugin by removing it from config.json. The server must be restarted for changes to take effect.',
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
            content: `Plugin "${name}" is not currently enabled.`,
            is_error: true,
          }
        }

        delete currentConfig.plugins[name]
        await saveConfig(currentConfig)

        return {
          content: `Plugin "${name}" has been disabled.\n\n` +
            `IMPORTANT: The server must be restarted for this change to take effect.\n` +
            `Tell the user to restart the toebeans server.`,
        }
      },
    },
  ]

  return {
    name: 'plugin-manager',
    description: `Plugin management tools:
- list_plugins: See all available plugins and their current state
- get_plugin_requirements: Get the configuration fields needed for a plugin
- enable_plugin: Enable a plugin (writes to config.json, requires server restart)
- disable_plugin: Disable a plugin (removes from config.json, requires server restart)

WORKFLOW for enabling a plugin:
1. Call get_plugin_requirements to see what config the plugin needs
2. Ask the user for any required information (especially API keys/tokens)
3. Once you have ALL required fields, call enable_plugin
4. Tell the user to restart the server`,

    tools,
  }
}
