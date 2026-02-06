import { z } from 'zod'
import { getDataDir } from './session.ts'
import { join } from 'path'

const configSchema = z.object({
  server: z.object({
    port: z.number(),
  }).passthrough(),
  session: z.object({
    compactAtTokens: z.number(),
    lifespanSeconds: z.number(),
  }).passthrough(),
  plugins: z.record(z.string(), z.unknown()),
  llm: z.object({
    provider: z.string(),
    model: z.string(),
    apiKey: z.string().optional(),
    thinkingBudget: z.number().optional(),
  }).passthrough(),
}).passthrough()

export type Config = z.infer<typeof configSchema>

// cache the raw config to preserve key order on save
let rawConfigCache: Record<string, unknown> | null = null

export async function loadConfig(): Promise<Config> {
  const configPath = join(getDataDir(), 'config.json')
  const file = Bun.file(configPath)

  if (!(await file.exists())) {
    console.error(`config file not found: ${configPath}`)
    console.error('create one to get started.')
    process.exit(1)
  }

  try {
    const raw = await file.json() as Record<string, unknown>
    rawConfigCache = raw
    return configSchema.parse(raw)
  } catch (err) {
    console.error('Failed to parse config:', err)
    process.exit(1)
  }
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
