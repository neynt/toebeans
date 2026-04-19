import { describe, test, expect, mock } from 'bun:test'
import type { Config } from './config.ts'

mock.module('./session.ts', () => ({
  getCurrentSessionId: async () => 'session-1',
  setCurrentSessionId: () => {},
  appendMessage: async () => {},
  appendEntry: async () => {},
  loadSession: async () => [],
  loadSessionEntries: async () => [],
  loadSystemPrompt: async () => 'system prompt',
  loadCostEntries: async () => [],
  estimateSessionTokens: async () => 150,
  getSessionLastActivity: async () => null,
  getSessionCreatedAt: async () => null,
  writeSession: async () => {},
  generateSessionId: async () => 'session-2',
}))

const { createSessionManager } = await import('./session-manager.ts') as typeof import('./session-manager.ts')

function fakeConfig(overrides: Partial<Config['session']> = {}): Config {
  return {
    server: { port: 3000 },
    session: {
      compactAtTokens: 1000,
      compactMinTokens: 100,
      lifespanSeconds: 1,
      ...overrides,
    },
    plugins: {},
    llm: { provider: 'anthropic', model: 'claude-sonnet-4-5-20250929' },
    timezone: 'UTC',
    restartMessage: 'restarted',
  } as Config
}

describe('session-manager learn-turn trigger semantics', () => {
  test('does not request compaction below the token threshold even if lifespan is low', async () => {
    const sm = createSessionManager(
      { name: 'fake', stream: async function* () {} },
      fakeConfig({ compactAtTokens: 500, lifespanSeconds: 0 }),
    )

    await expect(sm.needsCompaction('session-1', 'discord:test')).resolves.toBe(false)
  })

  test('requests compaction when token threshold is reached', async () => {
    const sm = createSessionManager(
      { name: 'fake', stream: async function* () {} },
      fakeConfig({ compactAtTokens: 150 }),
    )

    await expect(sm.needsCompaction('session-1', 'discord:test')).resolves.toBe(true)
  })
})
