import { homedir } from 'os'
import { join } from 'path'
import type { UsageTotals } from './cost.ts'

const SESSIONS_DIR = join(homedir(), '.toebeans', 'sessions')

export interface SessionCost {
  usage: UsageTotals
  /** estimated dollar cost (optimistic — assumes cache hits) */
  estimatedCost: number
  /** previous session IDs in the compaction chain */
  previousSessions: string[]
}

function getCostPath(sessionId: string): string {
  return join(SESSIONS_DIR, `${sessionId}-cost.json`)
}

export async function loadSessionCost(sessionId: string): Promise<SessionCost> {
  const file = Bun.file(getCostPath(sessionId))
  if (await file.exists()) {
    return await file.json() as SessionCost
  }
  return {
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    estimatedCost: 0,
    previousSessions: [],
  }
}

export async function saveSessionCost(sessionId: string, cost: SessionCost): Promise<void> {
  await Bun.write(getCostPath(sessionId), JSON.stringify(cost, null, 2))
}

/**
 * Add usage from an agent turn (or compaction call) to the session's cumulative cost.
 */
export async function addUsageToSession(
  sessionId: string,
  turnUsage: UsageTotals,
  turnCost: number,
): Promise<SessionCost> {
  const cost = await loadSessionCost(sessionId)
  cost.usage.input += turnUsage.input
  cost.usage.output += turnUsage.output
  cost.usage.cacheRead += turnUsage.cacheRead
  cost.usage.cacheWrite += turnUsage.cacheWrite
  cost.estimatedCost += turnCost
  await saveSessionCost(sessionId, cost)
  return cost
}

/**
 * Carry cost forward when compacting: copy cumulative cost to the new session,
 * adding the old session ID to the chain.
 */
export async function carrySessionCost(
  oldSessionId: string,
  newSessionId: string,
): Promise<SessionCost> {
  const oldCost = await loadSessionCost(oldSessionId)
  const newCost: SessionCost = {
    usage: { ...oldCost.usage },
    estimatedCost: oldCost.estimatedCost,
    previousSessions: [...oldCost.previousSessions, oldSessionId],
  }
  await saveSessionCost(newSessionId, newCost)
  return newCost
}
