import type { Tool, Message, AgentResult, ServerMessage } from './types.ts'
import { getPluginsDir } from './session.ts'
import { join, resolve, dirname } from 'path'
import { readdir } from 'node:fs/promises'

const BUILTIN_PLUGINS_DIR = resolve(dirname(import.meta.dir), 'plugins')

export interface Session {
  id: string
  messages: Message[]
}

export interface Plugin {
  name: string

  description?: string

  // capabilities
  tools?: Tool[]

  // lifecycle hooks
  on?: {
    'message:in'?: (msg: Message) => Message | Promise<Message>
    'message:out'?: (msg: Message) => Message | Promise<Message>
    'agent:start'?: (session: Session) => void | Promise<void>
    'agent:end'?: (session: Session, result: AgentResult) => void | Promise<void>
    'session:expire'?: (session: Session) => void | Promise<void>
  }

  // for channel plugins: yields incoming messages
  // outputTarget is optional - if provided, routes output to that target instead of back to this plugin
  // format: 'pluginName:target' (e.g., 'discord:channelId')
  input?: AsyncIterable<{ message: Message; outputTarget?: string }>

  // for channel plugins: send a response back
  // receives ServerMessage events (text, tool_use, tool_result, done, error)
  output?: (sessionId: string, message: ServerMessage) => Promise<void>

  // lifecycle
  init?: (config: unknown) => void | Promise<void>
  destroy?: () => void | Promise<void>
}

export interface LoadedPlugin {
  plugin: Plugin
  config: unknown
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()
  private serverContext?: any

  setServerContext(context: any) {
    this.serverContext = context
  }

  // discover all available plugin names (builtins + user plugins dir)
  async discoverAll(): Promise<string[]> {
    const names = new Set<string>()
    for (const dir of [BUILTIN_PLUGINS_DIR, getPluginsDir()]) {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isDirectory()) {
            names.add(entry.name)
          }
        }
      } catch {
        // dir might not exist
      }
    }
    return [...names].sort()
  }

  async loadPlugin(name: string, config?: unknown, { skipInit = false } = {}): Promise<void> {
    // try user plugins dir first (allows overriding builtins), then builtins
    const candidates = [
      join(getPluginsDir(), name, 'index.ts'),
      join(BUILTIN_PLUGINS_DIR, name, 'index.ts'),
    ]

    let plugin: Plugin | null = null
    for (const path of candidates) {
      try {
        const mod = await import(path)
        const exported = mod.default
        plugin = typeof exported === 'function' ? exported(this.serverContext) : exported
        break
      } catch {
        // try next
      }
    }

    if (!plugin) {
      throw new Error(`Plugin not found: ${name}`)
    }

    if (!skipInit && plugin.init) {
      await plugin.init(config)
    }

    this.plugins.set(name, { plugin, config })
  }

  getPlugin(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name)
  }

  getAllPlugins(): Map<string, LoadedPlugin> {
    return this.plugins
  }

  // get tools from all loaded plugins
  getTools(): Tool[] {
    const tools: Tool[] = []
    for (const [, loaded] of this.plugins) {
      if (loaded.plugin.tools) {
        tools.push(...loaded.plugin.tools)
      }
    }
    return tools
  }

  // build system prompt section for plugins
  getSystemPromptSection(): string {
    const sections: string[] = []

    for (const [name, loaded] of this.plugins) {
      if (loaded.plugin.description) {
        sections.push(`## ${name}\n${loaded.plugin.description}`)
      }
    }

    return sections.join('\n\n')
  }

  async destroy(): Promise<void> {
    for (const [, loaded] of this.plugins) {
      if (loaded.plugin.destroy) {
        await loaded.plugin.destroy()
      }
    }
    this.plugins.clear()
  }
}
