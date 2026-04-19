import type { ContentBlock } from './types.ts'
import type { ActiveTurnState } from './session.ts'
import { getInterruptedTurnResumeContent } from './auto-resume.ts'
import { migrateQueuedMessages, type QueuedMessage } from './queue-migration.ts'

export type CompactInterruptQueuedMessage = QueuedMessage

export interface CompactInterruptDeps {
  sessionBusy: Map<string, boolean>
  sessionAbort: Map<string, boolean>
  sessionAbortControllers: Map<string, AbortController>
  sessionProcessing: Map<string, Promise<void>>
  messageQueues: Map<string, CompactInterruptQueuedMessage[]>
  /** Sessions awaiting compaction. While present, processSession/plugin input
   *  loop must queue (not restart) rather than race the compact-interrupt flow. */
  compactPending: Set<string>
  getActiveTurns: () => Promise<ActiveTurnState[]>
  runLearnTurn: (sessionId: string, route: string, outputTarget: string | null) => Promise<string | null>
  startRecoveredSession: (
    sessionId: string,
    content: ContentBlock[],
    outputTarget: string | null,
    route: string,
    pluginName: string,
  ) => Promise<void>
  restartMessage: string
}

/**
 * Orchestrate a manual /compact that may land while an active turn is running.
 *
 * If a turn is in progress on the target session, we capture its resume info
 * (same shape used by the restart-recovery path), abort the turn, wait for it
 * to settle, then run the learn/finalize turn. On a successful compaction we
 * migrate any queued messages to the successor session and restart the
 * interrupted turn there so the user's in-flight work isn't dropped.
 */
export async function runCompactWithInterrupt(
  sessionId: string,
  route: string,
  outputTarget: string | null,
  deps: CompactInterruptDeps,
): Promise<string | null> {
  const {
    sessionBusy,
    sessionAbort,
    sessionAbortControllers,
    sessionProcessing,
    messageQueues,
    compactPending,
    getActiveTurns,
    runLearnTurn,
    startRecoveredSession,
    restartMessage,
  } = deps

  let interruptedResume: ContentBlock[] | null = null
  let interruptedPluginName = 'auto-resume'
  let interruptedOutputTarget: string | null = outputTarget
  let interruptedRoute: string = route

  const wasBusy = sessionBusy.get(sessionId) === true

  // Claim compaction ownership up-front: processSession's stranded-restart
  // path and the plugin input loop both honor this flag by queuing new
  // messages instead of kicking off a fresh processSession on the session
  // we're about to retire.
  compactPending.add(sessionId)

  try {
    if (wasBusy) {
      // Snapshot the active turn BEFORE signaling abort — the abort path
      // (runPersistentAgentTurn's finally) clears the resume.json entry.
      try {
        const activeTurns = await getActiveTurns()
        const activeTurn = activeTurns.find(t => t.sessionId === sessionId)
        if (activeTurn) {
          interruptedResume = getInterruptedTurnResumeContent(activeTurn, restartMessage)
          interruptedPluginName = activeTurn.pluginName || interruptedPluginName
          interruptedOutputTarget = activeTurn.outputTarget ?? interruptedOutputTarget
          interruptedRoute = activeTurn.route ?? interruptedRoute
        }
      } catch (err) {
        console.error('[compact] failed to read active turn state:', err)
      }

      // Signal abort via both channels (the boolean flag is checked in the
      // tool loop; the controller cuts the LLM stream mid-flight).
      sessionAbort.set(sessionId, true)
      const controller = sessionAbortControllers.get(sessionId)
      if (controller) {
        try { controller.abort() } catch {}
      }

      // Wait for the in-flight processSession to settle.
      const processing = sessionProcessing.get(sessionId)
      if (processing) {
        try { await processing } catch {}
      }

      // Defensive cleanup — processSession's finally ordinarily handles this,
      // but we clear explicitly so the learn turn runs on a quiet session.
      sessionBusy.set(sessionId, false)
      sessionAbort.set(sessionId, false)
    }

    const newSessionId = await runLearnTurn(sessionId, route, outputTarget)

    if (!newSessionId) {
      // Learn turn did not finalize. Resume the interrupted turn on the
      // original session so the user's work isn't dropped.
      if (interruptedResume) {
        await startRecoveredSession(
          sessionId,
          interruptedResume,
          interruptedOutputTarget,
          interruptedRoute,
          interruptedPluginName,
        )
      }
      return null
    }

    // Migrate queued messages onto the successor session so the recovered
    // turn's agent loop picks them up via checkQueuedMessages.
    const queued = migrateQueuedMessages(sessionId, newSessionId, messageQueues)

    if (interruptedResume) {
      await startRecoveredSession(
        newSessionId,
        interruptedResume,
        interruptedOutputTarget,
        interruptedRoute,
        interruptedPluginName,
      )
    } else if (queued.length > 0) {
      // No interrupted turn, but queued messages need draining. Start a
      // fresh turn on the successor with the queued content as its input
      // (messageQueues for newSessionId is cleared to avoid double-send).
      const queuedContent: ContentBlock[] = queued.flatMap(q => q.content)
      messageQueues.delete(newSessionId)
      await startRecoveredSession(
        newSessionId,
        queuedContent,
        outputTarget,
        route,
        'compact-queued',
      )
    }

    return newSessionId
  } finally {
    compactPending.delete(sessionId)
  }
}
