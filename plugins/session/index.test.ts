import { describe, test, expect } from 'bun:test'
import create from './index.ts'

describe('session plugin finalization isolation', () => {
  test('tracks pending finalization per session', async () => {
    const finalizeCalls: Array<{ sessionId: string; route?: string; summary: string }> = []
    const plugin = create({
      sessionManager: {
        async finalizeSession(sessionId: string, route: string | undefined, summary: string) {
          finalizeCalls.push({ sessionId, route, summary })
          return `${sessionId}-next`
        },
      },
    }) as ReturnType<typeof create> & {
      prepareFinalizeSession: (sessionId: string, route?: string) => void
    }

    const finalizeTool = plugin.tools!.find(tool => tool.name === 'session_finalize')!

    plugin.prepareFinalizeSession('session-a', 'discord:route-a')
    plugin.prepareFinalizeSession('session-b', 'discord:route-b')

    const [resultA, resultB] = await Promise.all([
      finalizeTool.execute({ summary: 'summary a' }, { sessionId: 'session-a', workingDir: '/tmp' }),
      finalizeTool.execute({ summary: 'summary b' }, { sessionId: 'session-b', workingDir: '/tmp' }),
    ])

    expect(resultA.is_error).toBeUndefined()
    expect(resultB.is_error).toBeUndefined()
    expect(finalizeCalls).toEqual([
      { sessionId: 'session-a', route: 'discord:route-a', summary: 'summary a' },
      { sessionId: 'session-b', route: 'discord:route-b', summary: 'summary b' },
    ])
  })

  test('clearPendingFinalization(sessionId) only clears that session', async () => {
    const plugin = create({
      sessionManager: {
        async finalizeSession() {
          return 'unused'
        },
      },
    }) as ReturnType<typeof create> & {
      prepareFinalizeSession: (sessionId: string, route?: string) => void
      clearPendingFinalization: (sessionId?: string) => void
      hasPendingFinalization: (sessionId?: string) => boolean
    }

    plugin.prepareFinalizeSession('session-a', 'discord:route-a')
    plugin.prepareFinalizeSession('session-b', 'discord:route-b')
    plugin.clearPendingFinalization('session-a')

    expect(plugin.hasPendingFinalization('session-a')).toBe(false)
    expect(plugin.hasPendingFinalization('session-b')).toBe(true)
    expect(plugin.hasPendingFinalization()).toBe(true)
  })
})
