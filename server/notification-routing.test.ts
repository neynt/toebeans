import { describe, test, expect } from 'bun:test'

/**
 * Tests for the server's route resolution logic when consuming plugin input.
 *
 * The server resolves route from queued messages via:
 *   const route = queuedMsg.route || outputTarget || pluginName
 *
 * When coding-agent plugins (claude-code, openai-codex, gemini-cli) queue
 * completion notifications, they must include the canonical `route` from the
 * spawning conversation so the notification lands in the correct session —
 * not a stale session keyed by the raw outputTarget.
 */

// Replicate the server's route resolution logic from server/index.ts
function resolveRoute(queuedMsg: { route?: string; outputTarget?: string }, pluginName: string): string {
  return queuedMsg.route || queuedMsg.outputTarget || pluginName
}

describe('notification route resolution', () => {
  test('prefers route over outputTarget when both are present', () => {
    const route = resolveRoute(
      { route: 'discord:example-guild-general-999999999999999999', outputTarget: 'discord:999999999999999999' },
      'claude-code',
    )
    expect(route).toBe('discord:example-guild-general-999999999999999999')
  })

  test('falls back to outputTarget when route is absent', () => {
    const route = resolveRoute(
      { outputTarget: 'discord:999999999999999999' },
      'claude-code',
    )
    expect(route).toBe('discord:999999999999999999')
  })

  test('falls back to pluginName when both are absent', () => {
    const route = resolveRoute({}, 'claude-code')
    expect(route).toBe('claude-code')
  })

  test('empty-string route falls back to outputTarget', () => {
    // empty string is falsy — should fall through
    const route = resolveRoute(
      { route: '', outputTarget: 'discord:999999999999999999' },
      'openai-codex',
    )
    expect(route).toBe('discord:999999999999999999')
  })
})

describe('coding-agent notification shape', () => {
  // Simulates the full flow: tool context → meta → queueNotification → QueuedMessage
  test('route flows from ToolContext through MetaFile to QueuedMessage', () => {
    // Step 1: ToolContext provides route and outputTarget
    const toolContext = {
      sessionId: 'test-session',
      workingDir: '/tmp',
      outputTarget: 'discord:999999999999999999',
      route: 'discord:example-guild-general-999999999999999999',
    }

    // Step 2: Plugin saves both in MetaFile
    const meta = {
      sessionId: 'cc-2025-01-15_10-30-00_abc1',
      task: 'fix the bug',
      workingDir: '/home/user/project',
      startedAt: '2025-01-15T10:30:00.000Z',
      pid: 12345,
      outputTarget: toolContext.outputTarget,
      route: toolContext.route,
    }

    // Step 3: On completion, plugin queues notification with meta.route
    const queuedMsg = {
      message: { role: 'user' as const, content: [{ type: 'text' as const, text: 'task done' }] },
      outputTarget: meta.outputTarget,
      route: meta.route,
      triggerNotice: 'Claude Code task completed',
    }

    // Step 4: Server resolves the canonical route
    const resolvedRoute = resolveRoute(queuedMsg, 'claude-code')
    expect(resolvedRoute).toBe('discord:example-guild-general-999999999999999999')
    // outputTarget is still the raw channel for reply routing
    expect(queuedMsg.outputTarget).toBe('discord:999999999999999999')
  })

  test('notification without route falls back gracefully', () => {
    // Old meta files from before this fix won't have route
    const meta = {
      sessionId: 'cc-old-session',
      task: 'old task',
      workingDir: '/tmp',
      startedAt: '2025-01-01T00:00:00.000Z',
      pid: 1,
      outputTarget: 'discord:999999999999999999',
      // no route field
    }

    const queuedMsg = {
      outputTarget: meta.outputTarget,
      route: (meta as any).route, // undefined
    }

    const resolvedRoute = resolveRoute(queuedMsg, 'openai-codex')
    // falls back to outputTarget — same as before the fix
    expect(resolvedRoute).toBe('discord:999999999999999999')
  })
})
