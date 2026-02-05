import { z } from 'zod'
import { getDataDir } from './session.ts'
import { join } from 'path'

const pluginConfigSchema = z.object({
  state: z.enum(['dormant', 'visible', 'loaded']),
  config: z.unknown().optional(),
})

const llmConfigSchema = z.object({
  provider: z.string().optional().default('anthropic'),
  model: z.string().optional(),
  apiKey: z.string().optional(),
}).optional().default({})

const configSchema = z.object({
  server: z.object({
    port: z.number().optional().default(3000),
  }).optional().default({}),
  session: z.object({
    expirySeconds: z.number().optional().default(3600), // 1 hour
    autoSummarize: z.boolean().optional().default(true),
  }).optional().default({}),
  plugins: z.record(z.string(), pluginConfigSchema).optional().default({}),
  llm: llmConfigSchema,
})

export type Config = z.infer<typeof configSchema>

const DEFAULT_CONFIG: Config = {
  server: {
    port: 3000,
  },
  session: {
    expirySeconds: 3600,
    autoSummarize: true,
  },
  plugins: {
    bash: { state: 'loaded', config: {} },
    memory: { state: 'visible', config: {} },
    plugins: { state: 'loaded', config: {} },
    'claude-code-direct': { state: 'loaded', config: {} },
  },
  llm: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
  },
}

// cache the raw config to preserve key order on save
let rawConfigCache: Record<string, unknown> | null = null

export async function loadConfig(): Promise<Config> {
  const configPath = join(getDataDir(), 'config.json')
  const file = Bun.file(configPath)

  if (await file.exists()) {
    try {
      const raw = await file.json() as Record<string, unknown>
      rawConfigCache = raw
      const config = configSchema.parse(raw)

      // merge in any new default plugins that aren't in the user's config
      let updated = false
      for (const [name, pluginConfig] of Object.entries(DEFAULT_CONFIG.plugins)) {
        if (!(name in config.plugins)) {
          config.plugins[name] = pluginConfig
          // also add to raw cache to preserve order
          if (rawConfigCache.plugins && typeof rawConfigCache.plugins === 'object') {
            (rawConfigCache.plugins as Record<string, unknown>)[name] = pluginConfig
          }
          updated = true
        }
      }
      if (updated) {
        await Bun.write(configPath, JSON.stringify(rawConfigCache, null, 2))
      }

      return config
    } catch (err) {
      console.error('Failed to parse config, using defaults:', err)
    }
  }

  // write default config
  rawConfigCache = structuredClone(DEFAULT_CONFIG) as Record<string, unknown>
  await Bun.write(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2))
  return DEFAULT_CONFIG
}

export async function saveConfig(config: Config): Promise<void> {
  const configPath = join(getDataDir(), 'config.json')

  // merge changes into the raw cache to preserve key order
  if (rawConfigCache) {
    // update top-level keys in original order, then add new ones
    for (const key of Object.keys(config) as (keyof Config)[]) {
      if (key === 'plugins') {
        // preserve plugin order: keep existing, add new at end
        const rawPlugins = (rawConfigCache.plugins ?? {}) as Record<string, unknown>
        const newPlugins = config.plugins

        // remove plugins that were deleted
        for (const name of Object.keys(rawPlugins)) {
          if (!(name in newPlugins)) {
            delete rawPlugins[name]
          }
        }
        // update existing and add new
        for (const [name, pluginConfig] of Object.entries(newPlugins)) {
          rawPlugins[name] = pluginConfig
        }
        rawConfigCache.plugins = rawPlugins
      } else {
        rawConfigCache[key] = config[key]
      }
    }
    await Bun.write(configPath, JSON.stringify(rawConfigCache, null, 2))
  } else {
    await Bun.write(configPath, JSON.stringify(config, null, 2))
  }
}
