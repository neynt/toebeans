import { z } from 'zod'
import { getDataDir } from './session.ts'
import { join } from 'path'
import type { PluginConfig } from './plugin.ts'

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
  session: z.object({
    expiryMs: z.number().optional().default(3600000), // 1 hour
    autoSummarize: z.boolean().optional().default(true),
  }).optional().default({}),
  plugins: z.record(z.string(), pluginConfigSchema).optional().default({}),
  llm: llmConfigSchema,
})

export type Config = z.infer<typeof configSchema>

const DEFAULT_CONFIG: Config = {
  session: {
    expiryMs: 3600000,
    autoSummarize: true,
  },
  plugins: {
    tools: { state: 'loaded', config: { allowBash: true } },
    memory: { state: 'visible', config: {} },
    'write-plugin': { state: 'visible', config: {} },
    'plugin-manager': { state: 'loaded', config: {} },
    core: { state: 'loaded', config: {} },
  },
  llm: {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250929',
  },
}

export async function loadConfig(): Promise<Config> {
  const configPath = join(getDataDir(), 'config.json')
  const file = Bun.file(configPath)

  if (await file.exists()) {
    try {
      const raw = await file.json()
      const config = configSchema.parse(raw)

      // merge in any new default plugins that aren't in the user's config
      let updated = false
      for (const [name, pluginConfig] of Object.entries(DEFAULT_CONFIG.plugins)) {
        if (!(name in config.plugins)) {
          config.plugins[name] = pluginConfig
          updated = true
        }
      }
      if (updated) {
        await Bun.write(configPath, JSON.stringify(config, null, 2))
      }

      return config
    } catch (err) {
      console.error('Failed to parse config, using defaults:', err)
    }
  }

  // write default config
  await Bun.write(configPath, JSON.stringify(DEFAULT_CONFIG, null, 2))
  return DEFAULT_CONFIG
}

export async function saveConfig(config: Config): Promise<void> {
  const configPath = join(getDataDir(), 'config.json')
  await Bun.write(configPath, JSON.stringify(config, null, 2))
}
