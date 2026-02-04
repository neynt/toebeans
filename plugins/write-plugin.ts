import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult } from '../server/types.ts'
import { getPluginsDir } from '../server/session.ts'
import { join } from 'path'

const PLUGIN_TEMPLATE = `import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult, ToolContext } from '../server/types.ts'
import { z } from 'zod'

// Optional: define config schema
const configSchema = z.object({
  // your config options here
})

type Config = z.infer<typeof configSchema>

export default function createPlugin(): Plugin<Config> {
  return {
    name: '{{NAME}}',

    // shown when plugin is visible (not loaded)
    summary: '{{SUMMARY}}',

    // shown when plugin is loaded
    description: \`{{DESCRIPTION}}\`,

    configSchema,

    tools: [
      {
        name: '{{TOOL_NAME}}',
        description: '{{TOOL_DESCRIPTION}}',
        inputSchema: {
          type: 'object',
          properties: {
            // your input properties
          },
          required: [],
        },
        async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
          // your implementation
          return { content: 'result' }
        },
      },
    ],

    // optional lifecycle hooks
    on: {
      // 'message:in': async (msg) => msg,
      // 'message:out': async (msg) => msg,
      // 'agent:start': async (session) => {},
      // 'agent:end': async (session, result) => {},
    },

    async init(config: Config) {
      // initialization logic
    },

    async destroy() {
      // cleanup logic
    },
  }
}
`

export default function createWritePluginPlugin(): Plugin {
  return {
    name: 'write-plugin',
    summary: 'Plugin authoring available. Use load_plugin("write-plugin") to create new plugins.',
    description: `Plugin authoring system.

Use write_plugin to create a new plugin. Plugins are TypeScript files stored in ~/.local/share/toebeans/plugins/.

Plugin structure:
- name: Unique identifier
- summary: One-line description (shown when visible)
- description: Full instructions (shown when loaded)
- tools: Array of tools with inputSchema and execute function
- on: Lifecycle hooks (message:in, message:out, agent:start, agent:end)
- init/destroy: Lifecycle methods

Plugins can:
- Provide tools for the agent to use
- Transform messages in/out
- React to agent lifecycle events
- Provide channel inputs (Discord, WhatsApp, etc.)`,

    tools: [
      {
        name: 'write_plugin',
        description: 'Create or update a plugin. The plugin will be hot-reloaded.',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Plugin name (used as filename)' },
            code: { type: 'string', description: 'Full TypeScript code for the plugin' },
          },
          required: ['name', 'code'],
        },
        async execute(input: unknown): Promise<ToolResult> {
          const { name, code } = input as { name: string; code: string }
          const pluginsDir = getPluginsDir()
          const filepath = join(pluginsDir, `${name}.ts`)

          try {
            await Bun.write(filepath, code)
            return { content: `Plugin written to ${filepath}. Restart server or use hot-reload to activate.` }
          } catch (err) {
            return { content: `Failed to write plugin: ${err}`, is_error: true }
          }
        },
      },
      {
        name: 'get_plugin_template',
        description: 'Get a template for creating a new plugin.',
        inputSchema: {
          type: 'object',
          properties: {},
          required: [],
        },
        async execute(): Promise<ToolResult> {
          return { content: PLUGIN_TEMPLATE }
        },
      },
    ],
  }
}
