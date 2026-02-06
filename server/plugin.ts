import type { Tool, Message, AgentResult, ServerMessage } from './types.ts'
import { getPluginsDir } from './session.ts'
import { join } from 'path'

export type PluginState = 'dormant' | 'visible' | 'loaded'

export interface Session {
  id: string
  messages: Message[]
}

export interface Plugin {
  name: string

  // context injection (based on state)
  summary?: string       // shown when state = 'visible' (~1 line)
  description?: string   // shown when state = 'loaded' (full instructions)

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

export interface PluginConfig {
  state: PluginState
  config?: unknown
}

export interface LoadedPlugin {
  plugin: Plugin
  state: PluginState
  config: unknown
}

export class PluginManager {
  private plugins = new Map<string, LoadedPlugin>()
  private builtinPlugins = new Map<string, () => Plugin>()
  private onLoadCallbacks: ((name: string, plugin: LoadedPlugin) => void)[] = []

  registerBuiltin(name: string, factory: () => Plugin): void {
    this.builtinPlugins.set(name, factory)
  }

  onPluginLoaded(callback: (name: string, plugin: LoadedPlugin) => void): void {
    this.onLoadCallbacks.push(callback)
  }

  getBuiltinNames(): string[] {
    return Array.from(this.builtinPlugins.keys())
  }

  async discoverUserPlugins(): Promise<string[]> {
    const userDir = getPluginsDir()
    const names: string[] = []
    const glob = new Bun.Glob('*.ts')
    try {
      for await (const file of glob.scan(userDir)) {
        names.push(file.replace('.ts', ''))
      }
    } catch {
      // dir might not exist
    }
    return names
  }

  async discoverAllPlugins(): Promise<string[]> {
    const builtins = this.getBuiltinNames()
    const user = await this.discoverUserPlugins()
    return [...new Set([...builtins, ...user])]
  }

  async loadPlugin(name: string, config: PluginConfig): Promise<void> {
    let plugin: Plugin

    // try builtin first
    const factory = this.builtinPlugins.get(name)
    if (factory) {
      plugin = factory()
    } else {
      // try user plugins dir
      const pluginPath = join(getPluginsDir(), `${name}.ts`)
      try {
        const mod = await import(pluginPath)
        plugin = mod.default as Plugin
      } catch (err) {
        throw new Error(`Plugin not found: ${name}`)
      }
    }

    // initialize
    if (plugin.init) {
      await plugin.init(config.config)
    }

    const loadedPlugin: LoadedPlugin = {
      plugin,
      state: config.state,
      config: config.config,
    }
    this.plugins.set(name, loadedPlugin)

    // notify listeners
    for (const callback of this.onLoadCallbacks) {
      callback(name, loadedPlugin)
    }
  }

  setState(name: string, state: PluginState): void {
    const loaded = this.plugins.get(name)
    if (loaded) {
      loaded.state = state
    }
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
      if (loaded.state === 'loaded' && loaded.plugin.tools) {
        tools.push(...loaded.plugin.tools)
      }
    }
    return tools
  }

  // build system prompt section for plugins
  getSystemPromptSection(): string {
    const sections: string[] = []

    for (const [name, loaded] of this.plugins) {
      if (loaded.state === 'visible' && loaded.plugin.summary) {
        sections.push(`[${name}] ${loaded.plugin.summary}`)
      } else if (loaded.state === 'loaded' && loaded.plugin.description) {
        sections.push(`## ${name}\n${loaded.plugin.description}`)
      }
    }

    return sections.join('\n\n')
  }

  // get list of visible plugins (for load_plugin tool)
  getVisiblePlugins(): string[] {
    return Array.from(this.plugins.entries())
      .filter(([, loaded]) => loaded.state === 'visible')
      .map(([name]) => name)
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
