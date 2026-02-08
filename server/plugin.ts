import type { Tool, Message, AgentResult, ServerMessage } from './types.ts'
import { getPluginsDir } from './session.ts'
import { join } from 'path'
import { readdir } from 'node:fs/promises'

// builtin plugin imports
import createBashPlugin from '../plugins/bash/index.ts'
import createMemoryPlugin from '../plugins/memory/index.ts'
import createDiscordPlugin from '../plugins/discord/index.ts'
import createClaudeCodeTmuxPlugin from '../plugins/claude-code-tmux/index.ts'
import createTimersPlugin from '../plugins/timers/index.ts'
import createClaudeCodeDirectPlugin from '../plugins/claude-code-direct/index.ts'
import createWebBrowsePlugin from '../plugins/web-browse/index.ts'
import createPluginsPlugin from '../plugins/plugins/index.ts'
import createGoogleSheetsPlugin from '../plugins/google-sheets/index.ts'
import createNanoBananaPlugin from '../plugins/nano-banana/index.ts'
import createOpenAICodexPlugin from '../plugins/openai-codex/index.ts'
import createViewImagePlugin from '../plugins/view-image/index.ts'

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
  input?: AsyncIterable<{ sessionId: string; message: Message; outputTarget?: string }>

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

const BUILTIN_PLUGINS: Record<string, (serverContext?: any) => Plugin> = {
  'bash': createBashPlugin,
  'memory': createMemoryPlugin,
  'discord': createDiscordPlugin,
  'claude-code-tmux': createClaudeCodeTmuxPlugin,
  'timers': createTimersPlugin,
  'claude-code-direct': createClaudeCodeDirectPlugin,
  'web-browse': createWebBrowsePlugin,
  'plugins': createPluginsPlugin,
  'google-sheets': createGoogleSheetsPlugin,
  'nano-banana': createNanoBananaPlugin,
  'openai-codex': createOpenAICodexPlugin,
  'view-image': createViewImagePlugin,
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()
  private serverContext?: any

  setServerContext(context: any) {
    this.serverContext = context
  }

  // discover all available plugin names (builtins + user plugins dir)
  async discoverAll(): Promise<string[]> {
    const names = new Set(Object.keys(BUILTIN_PLUGINS))
    const userDir = getPluginsDir()
    try {
      const entries = await readdir(userDir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory()) {
          names.add(entry.name)
        }
      }
    } catch {
      // dir might not exist
    }
    return [...names].sort()
  }

  async loadPlugin(name: string, config?: unknown, { skipInit = false } = {}): Promise<void> {
    let plugin: Plugin

    // try user plugins dir first (allows overriding builtins)
    const pluginPath = join(getPluginsDir(), name, 'index.ts')
    try {
      const mod = await import(pluginPath)
      const exported = mod.default
      plugin = typeof exported === 'function' ? exported(this.serverContext) : exported
    } catch {
      // fall back to builtin
      const factory = BUILTIN_PLUGINS[name]
      if (factory) {
        plugin = factory(this.serverContext)
      } else {
        throw new Error(`Plugin not found: ${name}`)
      }
    }

    // initialize
    if (!skipInit && plugin.init) {
      await plugin.init(config)
    }

    const loadedPlugin: LoadedPlugin = {
      plugin,
      config,
    }
    this.plugins.set(name, loadedPlugin)
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
