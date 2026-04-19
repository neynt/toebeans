import type { ContentBlock } from './types.ts'

export interface QueuedMessage {
  content: ContentBlock[]
  outputTarget: string
  metadata?: Record<string, unknown>
}

/**
 * Move any messages queued against `oldSessionId` onto `newSessionId` so a
 * successful learn/finalize turn doesn't strand input the user sent while it
 * was running. Returns the migrated messages so the caller can decide whether
 * to drain them as a new turn or let the existing agent loop pick them up.
 */
export function migrateQueuedMessages(
  oldSessionId: string,
  newSessionId: string,
  messageQueues: Map<string, QueuedMessage[]>,
): QueuedMessage[] {
  const queued = messageQueues.get(oldSessionId) ?? []
  messageQueues.delete(oldSessionId)
  if (queued.length === 0) return []
  const existing = messageQueues.get(newSessionId) ?? []
  messageQueues.set(newSessionId, [...existing, ...queued])
  return queued
}
