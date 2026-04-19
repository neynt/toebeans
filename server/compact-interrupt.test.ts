import { describe, test, expect } from 'bun:test'
import { runCompactWithInterrupt, type CompactInterruptDeps, type CompactInterruptQueuedMessage } from './compact-interrupt.ts'
import type { ActiveTurnState } from './session.ts'
import type { ContentBlock } from './types.ts'

interface Harness {
  deps: CompactInterruptDeps
  sessionBusy: Map<string, boolean>
  sessionAbort: Map<string, boolean>
  sessionAbortControllers: Map<string, AbortController>
  sessionProcessing: Map<string, Promise<void>>
  messageQueues: Map<string, CompactInterruptQueuedMessage[]>
  compactPending: Set<string>
  activeTurns: ActiveTurnState[]
  recoveredSessions: Array<{
    sessionId: string
    content: ContentBlock[]
    outputTarget: string | null
    route: string
    pluginName: string
  }>
  learnTurnCalls: Array<{ sessionId: string; route: string; outputTarget: string | null }>
}

/** Build a test harness with the state maps + injected deps under our control. */
function makeHarness(opts: {
  activeTurns?: ActiveTurnState[]
  runLearnTurn?: (sessionId: string, route: string, outputTarget: string | null) => Promise<string | null>
  compactPendingSnapshotWhileLearning?: Set<boolean>
} = {}): Harness {
  const sessionBusy = new Map<string, boolean>()
  const sessionAbort = new Map<string, boolean>()
  const sessionAbortControllers = new Map<string, AbortController>()
  const sessionProcessing = new Map<string, Promise<void>>()
  const messageQueues = new Map<string, CompactInterruptQueuedMessage[]>()
  const compactPending = new Set<string>()
  const activeTurns = opts.activeTurns ?? []
  const recoveredSessions: Harness['recoveredSessions'] = []
  const learnTurnCalls: Harness['learnTurnCalls'] = []

  const defaultRunLearnTurn: CompactInterruptDeps['runLearnTurn'] = async (sessionId, route, outputTarget) => {
    learnTurnCalls.push({ sessionId, route, outputTarget })
    // record whether compactPending is set during the learn turn itself
    opts.compactPendingSnapshotWhileLearning?.add(compactPending.has(sessionId))
    return `${sessionId}-successor`
  }

  const deps: CompactInterruptDeps = {
    sessionBusy,
    sessionAbort,
    sessionAbortControllers,
    sessionProcessing,
    messageQueues,
    compactPending,
    getActiveTurns: async () => activeTurns.slice(),
    runLearnTurn: opts.runLearnTurn ?? defaultRunLearnTurn,
    startRecoveredSession: async (sessionId, content, outputTarget, route, pluginName) => {
      recoveredSessions.push({ sessionId, content, outputTarget, route, pluginName })
      // Mirror the real implementation: mark the successor as busy.
      sessionBusy.set(sessionId, true)
      sessionAbort.set(sessionId, false)
    },
    restartMessage: 'server restarted',
  }

  return {
    deps,
    sessionBusy,
    sessionAbort,
    sessionAbortControllers,
    sessionProcessing,
    messageQueues,
    compactPending,
    activeTurns,
    recoveredSessions,
    learnTurnCalls,
  }
}

describe('runCompactWithInterrupt', () => {
  test('no active turn: runs learn turn and does not resume anything', async () => {
    const h = makeHarness()
    const result = await runCompactWithInterrupt('sess-1', 'discord:foo', 'discord:foo', h.deps)

    expect(result).toBe('sess-1-successor')
    expect(h.learnTurnCalls).toEqual([{ sessionId: 'sess-1', route: 'discord:foo', outputTarget: 'discord:foo' }])
    expect(h.recoveredSessions).toEqual([])
    // compactPending cleanly cleared
    expect(h.compactPending.has('sess-1')).toBe(false)
  })

  test('busy session: aborts the active turn, waits for it to settle, then runs learn', async () => {
    const h = makeHarness({
      activeTurns: [{
        sessionId: 'sess-2',
        route: 'discord:bar',
        outputTarget: 'discord:bar',
        pluginName: 'discord',
        startedAt: '2026-04-01T00:00:00.000Z',
        initialContent: [{ type: 'text', text: 'original ask' }],
        userMessagePersisted: true,
      }],
    })

    const abortController = new AbortController()
    h.sessionAbortControllers.set('sess-2', abortController)
    h.sessionBusy.set('sess-2', true)

    // fake in-flight turn: resolves when abort fires
    let settled = false
    const processing = new Promise<void>(resolve => {
      abortController.signal.addEventListener('abort', () => {
        // mimic processSession's finally clearing busy after abort
        h.sessionBusy.set('sess-2', false)
        settled = true
        resolve()
      })
    })
    h.sessionProcessing.set('sess-2', processing)

    const result = await runCompactWithInterrupt('sess-2', 'discord:bar', 'discord:bar', h.deps)

    expect(settled).toBe(true)
    expect(abortController.signal.aborted).toBe(true)
    expect(h.sessionAbort.get('sess-2')).toBe(false) // helper cleared after settle
    expect(result).toBe('sess-2-successor')

    // interrupted turn was resumed on the successor, using restartMessage
    // (userMessagePersisted=true → restart semantics)
    expect(h.recoveredSessions).toEqual([{
      sessionId: 'sess-2-successor',
      content: [{ type: 'text', text: 'server restarted' }],
      outputTarget: 'discord:bar',
      route: 'discord:bar',
      pluginName: 'discord',
    }])
    expect(h.compactPending.has('sess-2')).toBe(false)
  })

  test('busy session with un-persisted user message: resume replays original content', async () => {
    const h = makeHarness({
      activeTurns: [{
        sessionId: 'sess-3',
        route: 'discord:baz',
        outputTarget: 'discord:baz',
        pluginName: 'discord',
        startedAt: '2026-04-01T00:00:00.000Z',
        initialContent: [{ type: 'text', text: 'replay me' }],
        userMessagePersisted: false,
      }],
    })

    h.sessionBusy.set('sess-3', true)
    h.sessionProcessing.set('sess-3', Promise.resolve())

    await runCompactWithInterrupt('sess-3', 'discord:baz', 'discord:baz', h.deps)

    expect(h.recoveredSessions).toHaveLength(1)
    expect(h.recoveredSessions[0]!.content).toEqual([{ type: 'text', text: 'replay me' }])
  })

  test('migrates queued messages onto the successor session', async () => {
    const h = makeHarness({
      activeTurns: [{
        sessionId: 'sess-4',
        route: 'discord:qux',
        outputTarget: 'discord:qux',
        pluginName: 'discord',
        startedAt: '2026-04-01T00:00:00.000Z',
        initialContent: [{ type: 'text', text: 'initial' }],
        userMessagePersisted: true,
      }],
    })

    h.sessionBusy.set('sess-4', true)
    h.sessionProcessing.set('sess-4', Promise.resolve())
    h.messageQueues.set('sess-4', [
      { content: [{ type: 'text', text: 'hey' }], outputTarget: 'discord:qux' },
      { content: [{ type: 'text', text: 'you there?' }], outputTarget: 'discord:qux' },
    ])

    const result = await runCompactWithInterrupt('sess-4', 'discord:qux', 'discord:qux', h.deps)

    expect(result).toBe('sess-4-successor')
    expect(h.messageQueues.get('sess-4')).toBeUndefined()
    expect(h.messageQueues.get('sess-4-successor')).toEqual([
      { content: [{ type: 'text', text: 'hey' }], outputTarget: 'discord:qux' },
      { content: [{ type: 'text', text: 'you there?' }], outputTarget: 'discord:qux' },
    ])
    // the interrupted turn still restarts (its resume content goes onto the new session)
    expect(h.recoveredSessions).toHaveLength(1)
    expect(h.recoveredSessions[0]!.sessionId).toBe('sess-4-successor')
  })

  test('learn turn fails (no finalize): resumes interrupted turn on the ORIGINAL session', async () => {
    const h = makeHarness({
      activeTurns: [{
        sessionId: 'sess-5',
        route: 'discord:fizz',
        outputTarget: 'discord:fizz',
        pluginName: 'discord',
        startedAt: '2026-04-01T00:00:00.000Z',
        initialContent: [{ type: 'text', text: 'mid-work' }],
        userMessagePersisted: true,
      }],
      runLearnTurn: async () => null, // compaction failed
    })

    h.sessionBusy.set('sess-5', true)
    h.sessionProcessing.set('sess-5', Promise.resolve())

    const result = await runCompactWithInterrupt('sess-5', 'discord:fizz', 'discord:fizz', h.deps)

    expect(result).toBeNull()
    expect(h.recoveredSessions).toEqual([{
      sessionId: 'sess-5', // original session, not a successor
      content: [{ type: 'text', text: 'server restarted' }],
      outputTarget: 'discord:fizz',
      route: 'discord:fizz',
      pluginName: 'discord',
    }])
    expect(h.compactPending.has('sess-5')).toBe(false)
  })

  test('learn turn fails with no active turn: nothing to resume, returns null', async () => {
    const h = makeHarness({
      runLearnTurn: async () => null,
    })

    const result = await runCompactWithInterrupt('sess-6', 'ws', null, h.deps)

    expect(result).toBeNull()
    expect(h.recoveredSessions).toEqual([])
    expect(h.compactPending.has('sess-6')).toBe(false)
  })

  test('compactPending flag is held across the abort + learn window, then cleared', async () => {
    const snapshot = new Set<boolean>()
    const h = makeHarness({
      activeTurns: [{
        sessionId: 'sess-7',
        route: 'discord:bing',
        outputTarget: 'discord:bing',
        pluginName: 'discord',
        startedAt: '2026-04-01T00:00:00.000Z',
        initialContent: [{ type: 'text', text: 'x' }],
        userMessagePersisted: true,
      }],
      compactPendingSnapshotWhileLearning: snapshot,
    })

    h.sessionBusy.set('sess-7', true)
    h.sessionProcessing.set('sess-7', Promise.resolve())

    await runCompactWithInterrupt('sess-7', 'discord:bing', 'discord:bing', h.deps)

    expect(snapshot.has(true)).toBe(true) // set during learn turn
    expect(h.compactPending.has('sess-7')).toBe(false) // cleared after return
  })

  test('abort propagates via both the flag and the AbortController', async () => {
    const h = makeHarness({
      activeTurns: [{
        sessionId: 'sess-8',
        route: 'r',
        outputTarget: null,
        pluginName: 'p',
        startedAt: '2026-04-01T00:00:00.000Z',
        initialContent: [{ type: 'text', text: 'q' }],
        userMessagePersisted: true,
      }],
    })

    const controller = new AbortController()
    h.sessionAbortControllers.set('sess-8', controller)
    h.sessionBusy.set('sess-8', true)

    let abortFlagSeen = false
    // the "turn" only finishes once abort fires — at that moment, inspect the flag
    h.sessionProcessing.set('sess-8', new Promise<void>(resolve => {
      controller.signal.addEventListener('abort', () => {
        abortFlagSeen = h.sessionAbort.get('sess-8') === true
        resolve()
      })
    }))

    await runCompactWithInterrupt('sess-8', 'r', null, h.deps)

    expect(abortFlagSeen).toBe(true)
    expect(controller.signal.aborted).toBe(true)
  })

  test('session was not busy: skips the abort+await path entirely', async () => {
    const h = makeHarness()
    // hanging promise — if the helper awaits it, Promise.race's timeout wins
    h.sessionProcessing.set('sess-9', new Promise<void>(() => {}))

    // session is NOT marked busy, so the helper must not touch sessionProcessing
    const result = await Promise.race([
      runCompactWithInterrupt('sess-9', 'r', null, h.deps),
      new Promise<string>((_, reject) =>
        setTimeout(() => reject(new Error('helper hung on sessionProcessing')), 500),
      ),
    ])

    expect(result).toBe('sess-9-successor')
    expect(h.learnTurnCalls).toHaveLength(1)
    expect(h.recoveredSessions).toEqual([]) // no active turn → no resume
  })

  test('queued messages but no active turn: drains them on the successor', async () => {
    const h = makeHarness({ activeTurns: [] })
    h.messageQueues.set('sess-10', [
      { content: [{ type: 'text', text: 'stranded' }], outputTarget: 'ws' },
    ])

    await runCompactWithInterrupt('sess-10', 'ws', null, h.deps)

    expect(h.recoveredSessions).toEqual([{
      sessionId: 'sess-10-successor',
      content: [{ type: 'text', text: 'stranded' }],
      outputTarget: null,
      route: 'ws',
      pluginName: 'compact-queued',
    }])
    // the migrated-then-drained queue is now empty
    expect(h.messageQueues.get('sess-10')).toBeUndefined()
    expect(h.messageQueues.get('sess-10-successor')).toBeUndefined()
  })

  test('messages arriving DURING the learn turn migrate to the successor (no active turn)', async () => {
    // simulate messages landing while the learn turn is in flight — they
    // must not be stranded on the predecessor. With no active turn, they
    // become the successor's initial content via startRecoveredSession.
    const messageQueues = new Map<string, CompactInterruptQueuedMessage[]>()
    const recovered: Array<{ sessionId: string; content: ContentBlock[]; pluginName: string }> = []

    const deps: CompactInterruptDeps = {
      sessionBusy: new Map(),
      sessionAbort: new Map(),
      sessionAbortControllers: new Map(),
      sessionProcessing: new Map(),
      messageQueues,
      compactPending: new Set(),
      getActiveTurns: async () => [],
      runLearnTurn: async (sessionId) => {
        // messages arrive through the plugin input loop while the learn turn
        // is running — they land on the predecessor session's queue
        messageQueues.set(sessionId, [
          { content: [{ type: 'text', text: 'mid-learn-1' }], outputTarget: 'discord:foo' },
          { content: [{ type: 'text', text: 'mid-learn-2' }], outputTarget: 'discord:foo' },
        ])
        return `${sessionId}-successor`
      },
      startRecoveredSession: async (sessionId, content, _outputTarget, _route, pluginName) => {
        recovered.push({ sessionId, content, pluginName })
      },
      restartMessage: 'restarted',
    }

    const result = await runCompactWithInterrupt('sess-mid', 'discord:foo', 'discord:foo', deps)

    expect(result).toBe('sess-mid-successor')
    // predecessor queue cleared, queue was drained onto successor startup
    expect(messageQueues.get('sess-mid')).toBeUndefined()
    expect(messageQueues.get('sess-mid-successor')).toBeUndefined()
    expect(recovered).toEqual([{
      sessionId: 'sess-mid-successor',
      content: [
        { type: 'text', text: 'mid-learn-1' },
        { type: 'text', text: 'mid-learn-2' },
      ],
      pluginName: 'compact-queued',
    }])
  })

  test('messages arriving DURING the learn turn migrate to the successor (with active turn)', async () => {
    // With an active turn AND messages arriving during the learn turn: the
    // interrupted turn restarts on the successor, and mid-learn messages end
    // up on the successor's queue (to be drained by checkQueuedMessages).
    const messageQueues = new Map<string, CompactInterruptQueuedMessage[]>()
    const recovered: Array<{ sessionId: string; content: ContentBlock[]; pluginName: string }> = []
    const activeTurns: ActiveTurnState[] = [{
      sessionId: 'sess-both',
      route: 'discord:foo',
      outputTarget: 'discord:foo',
      pluginName: 'discord',
      startedAt: '2026-04-01T00:00:00.000Z',
      initialContent: [{ type: 'text', text: 'original' }],
      userMessagePersisted: true,
    }]

    const deps: CompactInterruptDeps = {
      sessionBusy: new Map([['sess-both', true]]),
      sessionAbort: new Map(),
      sessionAbortControllers: new Map(),
      sessionProcessing: new Map([['sess-both', Promise.resolve()]]),
      messageQueues,
      compactPending: new Set(),
      getActiveTurns: async () => activeTurns.slice(),
      runLearnTurn: async (sessionId) => {
        messageQueues.set(sessionId, [
          { content: [{ type: 'text', text: 'mid-learn' }], outputTarget: 'discord:foo' },
        ])
        return `${sessionId}-successor`
      },
      startRecoveredSession: async (sessionId, content, _outputTarget, _route, pluginName) => {
        recovered.push({ sessionId, content, pluginName })
      },
      restartMessage: 'restarted',
    }

    await runCompactWithInterrupt('sess-both', 'discord:foo', 'discord:foo', deps)

    // interrupted turn was resumed on the successor (with restart message)
    expect(recovered).toEqual([{
      sessionId: 'sess-both-successor',
      content: [{ type: 'text', text: 'restarted' }],
      pluginName: 'discord',
    }])
    // mid-learn messages land on the successor's queue, picked up by the
    // agent loop's checkQueuedMessages after the first tool round
    expect(messageQueues.get('sess-both')).toBeUndefined()
    expect(messageQueues.get('sess-both-successor')).toEqual([
      { content: [{ type: 'text', text: 'mid-learn' }], outputTarget: 'discord:foo' },
    ])
  })

  test('messages arriving DURING a FAILED learn turn stay on the original session', async () => {
    // If the learn turn doesn't finalize, mid-learn messages must remain on
    // the predecessor (where the interrupted turn resumes) so they're not lost.
    const messageQueues = new Map<string, CompactInterruptQueuedMessage[]>()
    const recovered: Array<{ sessionId: string; content: ContentBlock[] }> = []

    const deps: CompactInterruptDeps = {
      sessionBusy: new Map([['sess-fail', true]]),
      sessionAbort: new Map(),
      sessionAbortControllers: new Map(),
      sessionProcessing: new Map([['sess-fail', Promise.resolve()]]),
      messageQueues,
      compactPending: new Set(),
      getActiveTurns: async () => [{
        sessionId: 'sess-fail',
        route: 'discord:foo',
        outputTarget: 'discord:foo',
        pluginName: 'discord',
        startedAt: '2026-04-01T00:00:00.000Z',
        initialContent: [{ type: 'text', text: 'mid-work' }],
        userMessagePersisted: true,
      }],
      runLearnTurn: async (sessionId) => {
        messageQueues.set(sessionId, [
          { content: [{ type: 'text', text: 'mid-learn' }], outputTarget: 'discord:foo' },
        ])
        return null // finalize failed
      },
      startRecoveredSession: async (sessionId, content) => {
        recovered.push({ sessionId, content })
      },
      restartMessage: 'restarted',
    }

    const result = await runCompactWithInterrupt('sess-fail', 'discord:foo', 'discord:foo', deps)

    expect(result).toBeNull()
    // resume on ORIGINAL session
    expect(recovered).toEqual([{ sessionId: 'sess-fail', content: [{ type: 'text', text: 'restarted' }] }])
    // mid-learn messages remain on the original session so the resumed turn's
    // agent loop drains them via checkQueuedMessages
    expect(messageQueues.get('sess-fail')).toEqual([
      { content: [{ type: 'text', text: 'mid-learn' }], outputTarget: 'discord:foo' },
    ])
  })

  test('compactPending is cleared even when runLearnTurn throws', async () => {
    const h = makeHarness({
      runLearnTurn: async () => { throw new Error('boom') },
    })

    expect(runCompactWithInterrupt('sess-11', 'r', null, h.deps)).rejects.toThrow('boom')
    // give the rejection a microtask to flush so finally runs before we assert
    await Promise.resolve()
    expect(h.compactPending.has('sess-11')).toBe(false)
  })
})
