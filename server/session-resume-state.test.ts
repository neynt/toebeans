import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { rm } from 'node:fs/promises'

const RESUME_PATH = join(homedir(), '.toebeans', 'resume.json')
const sessionModule = await import(`./session.ts?resume-state-test=${Date.now()}`) as typeof import('./session.ts')

async function cleanup() {
  try { await rm(RESUME_PATH) } catch {}
}

describe('resume state persistence', () => {
  beforeEach(cleanup)
  afterEach(cleanup)

  test('active turn and last output target share the same state file', async () => {
    await sessionModule.setLastOutputTarget('discord:chan-1', 'discord:route-1')
    await sessionModule.setActiveTurn({
      sessionId: 'discord-route-1-2026-04-01-0000',
      route: 'discord:route-1',
      outputTarget: 'discord:chan-1',
      pluginName: 'discord',
      startedAt: '2026-04-01T00:00:00.000Z',
      initialContent: [{ type: 'text', text: 'continue this' }],
      userMessagePersisted: true,
    })

    expect(await sessionModule.getLastOutputTarget()).toEqual({
      outputTarget: 'discord:chan-1',
      route: 'discord:route-1',
    })
    expect(await sessionModule.getActiveTurns()).toEqual([{
      sessionId: 'discord-route-1-2026-04-01-0000',
      route: 'discord:route-1',
      outputTarget: 'discord:chan-1',
      pluginName: 'discord',
      startedAt: '2026-04-01T00:00:00.000Z',
      initialContent: [{ type: 'text', text: 'continue this' }],
      userMessagePersisted: true,
    }])
  })

  test('clearing one resume field preserves the other', async () => {
    await sessionModule.setLastOutputTarget('discord:chan-2', 'discord:route-2')
    await sessionModule.setActiveTurn({
      sessionId: 'discord-route-2-2026-04-01-0000',
      route: 'discord:route-2',
      outputTarget: 'discord:chan-2',
      pluginName: 'discord',
      startedAt: '2026-04-01T01:00:00.000Z',
      initialContent: [{ type: 'text', text: 'ping' }],
      userMessagePersisted: false,
    })

    await sessionModule.setLastOutputTarget(null)
    expect(await sessionModule.getLastOutputTarget()).toBeNull()
    expect(await sessionModule.getActiveTurns()).toHaveLength(1)

    await sessionModule.setActiveTurn(null, 'discord-route-2-2026-04-01-0000')
    expect(await sessionModule.getActiveTurns()).toEqual([])
    expect(await sessionModule.getLastOutputTarget()).toBeNull()
  })

  test('multiple active turns can be recovered independently', async () => {
    await sessionModule.setActiveTurn({
      sessionId: 'discord-route-a-2026-04-01-0000',
      route: 'discord:route-a',
      outputTarget: 'discord:chan-a',
      pluginName: 'discord',
      startedAt: '2026-04-01T02:00:00.000Z',
      initialContent: [{ type: 'text', text: 'a' }],
      userMessagePersisted: true,
    })
    await sessionModule.setActiveTurn({
      sessionId: 'discord-route-b-2026-04-01-0000',
      route: 'discord:route-b',
      outputTarget: 'discord:chan-b',
      pluginName: 'discord',
      startedAt: '2026-04-01T02:01:00.000Z',
      initialContent: [{ type: 'text', text: 'b' }],
      userMessagePersisted: false,
    })

    const activeTurns = await sessionModule.getActiveTurns()
    expect(activeTurns).toHaveLength(2)
    expect(activeTurns.map(turn => turn.sessionId).sort()).toEqual([
      'discord-route-a-2026-04-01-0000',
      'discord-route-b-2026-04-01-0000',
    ])
  })
})
