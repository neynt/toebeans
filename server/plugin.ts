import type { Tool, Message, ServerMessage } from './types.ts'
import type { LlmProvider } from './llm-provider.ts'
import { getPluginsDir } from './session.ts'
import { join, resolve, dirname } from 'path'
import { readdir } from 'node:fs/promises'

const BUILTIN_PLUGINS_DIR = resolve(dirname(import.meta.dir), 'plugins')

export interface PreCompactionContext {
  sessionId: string
  route?: string
  messages: Message[]
  provider: LlmProvider
}

/** A running task reported by a plugin's status() method. */
export interface PluginStatusTask {
  id: string
  description: string
  startedAt: string
  [key: string]: unknown
}

/** Status object returned by a plugin's status() method. */
export interface PluginStatus {
  tasks?: PluginStatusTask[]
  [key: string]: unknown
}

/** Describes a single config field a plugin accepts. */
export interface ConfigField {
  key: string
  type: 'string' | 'number' | 'boolean'
  description?: string
  default?: unknown
  secret?: boolean // for API keys — value is masked in the dashboard
}

export interface Plugin {
  name: string

  description?: string

  // capabilities
  tools?: Tool[]

  // optional: declare accepted config fields for dashboard visibility
  configSchema?: ConfigField[]

  // hooks
  onPreCompaction?: (context: PreCompactionContext) => void | Promise<void>
  buildSystemPrompt?: () => string | null | Promise<string | null>

  // status reporting — return current plugin status (active tasks, etc.)
  status?: () => PluginStatus | null | Promise<PluginStatus | null>

  // optional structured data for dashboard rendering (e.g. grouped skills)
  dashboardData?: () => unknown | Promise<unknown>

  // for channel plugins: yields incoming messages
  // outputTarget is optional - if provided, routes output to that target instead of back to this plugin
  // format: 'pluginName:target' (e.g., 'discord:channelId')
  // metadata is optional - opaque data passed back via queued/dequeued control messages
  // `automatic: true` marks messages produced without direct user action
  // (timer fires, coding-agent task completion notifications, etc). The server
  // uses this to suppress automatic traffic into sessions that are stuck in a
  // failed-learn-turn state, so they don't keep digging the hole deeper.
  input?: AsyncIterable<{ message: Message; outputTarget?: string; route?: string; metadata?: Record<string, unknown>; triggerNotice?: string; automatic?: boolean }>

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

  async firePreCompaction(context: PreCompactionContext): Promise<void> {
    for (const [, loaded] of this.plugins) {
      if (loaded.plugin.onPreCompaction) {
        await loaded.plugin.onPreCompaction(context)
      }
    }
  }

  async buildSystemPrompts(): Promise<string[]> {
    const results: string[] = []
    for (const [, loaded] of this.plugins) {
      if (loaded.plugin.buildSystemPrompt) {
        const result = await loaded.plugin.buildSystemPrompt()
        if (result) {
          results.push(result)
        }
      }
    }
    return results
  }

  // unified section: plugin descriptions + plugin-contributed prompts under one # Plugins heading
  async buildPluginsSection(): Promise<string> {
    const subsections: string[] = []

    for (const [name, loaded] of this.plugins) {
      // plugin description (tool usage instructions, etc.)
      if (loaded.plugin.description) {
        subsections.push(`## ${name}\n${loaded.plugin.description}`)
      }

      // plugin-contributed system prompt content (memory, skills, device lists, etc.)
      if (loaded.plugin.buildSystemPrompt) {
        const content = await loaded.plugin.buildSystemPrompt()
        if (content) {
          subsections.push(content)
        }
      }
    }

    if (subsections.length === 0) return ''
    return `# Plugins\n\n${subsections.join('\n\n')}`
  }

  /** Per-plugin context breakdown: description, system prompt contribution, tools, dashboard data. */
  async getPluginContexts(): Promise<{ name: string; description: string | null; systemPrompt: string | null; tools: { name: string; description: string }[]; dashboardData?: unknown }[]> {
    const results: { name: string; description: string | null; systemPrompt: string | null; tools: { name: string; description: string }[]; dashboardData?: unknown }[] = []
    for (const [name, loaded] of this.plugins) {
      let systemPrompt: string | null = null
      if (loaded.plugin.buildSystemPrompt) {
        try {
          systemPrompt = await loaded.plugin.buildSystemPrompt() ?? null
        } catch (err) {
          systemPrompt = `[error: ${err instanceof Error ? err.message : String(err)}]`
        }
      }
      let dashboardData: unknown = undefined
      if (loaded.plugin.dashboardData) {
        try {
          dashboardData = await loaded.plugin.dashboardData() ?? undefined
        } catch {
          // ignore dashboard data errors
        }
      }
      results.push({
        name,
        description: loaded.plugin.description ?? null,
        systemPrompt,
        tools: (loaded.plugin.tools ?? []).map(t => ({ name: t.name, description: t.description })),
        ...(dashboardData !== undefined ? { dashboardData } : {}),
      })
    }
    return results
  }

  /** Collect status from all plugins that implement status(). */
  async getPluginStatuses(): Promise<Map<string, PluginStatus>> {
    const statuses = new Map<string, PluginStatus>()
    for (const [name, loaded] of this.plugins) {
      if (loaded.plugin.status) {
        try {
          const status = await loaded.plugin.status()
          if (status) {
            statuses.set(name, status)
          }
        } catch (err) {
          console.error(`[plugin-manager] error getting status from ${name}:`, err)
        }
      }
    }
    return statuses
  }

  /** Return config schemas + current values for all loaded plugins. */
  getPluginConfigSchemas(): { name: string; schema: ConfigField[]; config: unknown }[] {
    const results: { name: string; schema: ConfigField[]; config: unknown }[] = []
    for (const [name, loaded] of this.plugins) {
      results.push({
        name,
        schema: loaded.plugin.configSchema ?? [],
        config: loaded.config ?? {},
      })
    }
    return results
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
