import { describe, test, expect, beforeEach } from 'bun:test'
import { homedir } from 'os'
import { join } from 'path'
import { mkdir, rm } from 'node:fs/promises'
import { loadSessionCost, saveSessionCost, addUsageToSession, carrySessionCost } from './session-cost.ts'

const SESSIONS_DIR = join(homedir(), '.toebeans', 'sessions')
const TEST_SESSION = '_test-cost-tracking'
const TEST_SESSION_2 = '_test-cost-tracking-2'

async function cleanup() {
  for (const id of [TEST_SESSION, TEST_SESSION_2]) {
    const path = join(SESSIONS_DIR, `${id}-cost.json`)
    try { await rm(path) } catch {}
  }
}

describe('session-cost', () => {
  beforeEach(async () => {
    await mkdir(SESSIONS_DIR, { recursive: true })
    await cleanup()
  })

  test('loadSessionCost returns zeros for nonexistent session', async () => {
    const cost = await loadSessionCost(TEST_SESSION)
    expect(cost.usage.input).toBe(0)
    expect(cost.usage.output).toBe(0)
    expect(cost.estimatedCost).toBe(0)
    expect(cost.previousSessions).toEqual([])
  })

  test('addUsageToSession accumulates across calls', async () => {
    const usage1 = { input: 1000, output: 500, cacheRead: 200, cacheWrite: 100 }
    const cost1 = await addUsageToSession(TEST_SESSION, usage1, 0.05)
    expect(cost1.usage.input).toBe(1000)
    expect(cost1.usage.output).toBe(500)
    expect(cost1.estimatedCost).toBe(0.05)

    const usage2 = { input: 2000, output: 1000, cacheRead: 0, cacheWrite: 0 }
    const cost2 = await addUsageToSession(TEST_SESSION, usage2, 0.10)
    expect(cost2.usage.input).toBe(3000)
    expect(cost2.usage.output).toBe(1500)
    expect(cost2.usage.cacheRead).toBe(200)
    expect(cost2.estimatedCost).toBeCloseTo(0.15)
  })

  test('carrySessionCost copies cumulative cost to new session', async () => {
    await addUsageToSession(TEST_SESSION, { input: 5000, output: 2000, cacheRead: 0, cacheWrite: 0 }, 0.50)

    const carried = await carrySessionCost(TEST_SESSION, TEST_SESSION_2)
    expect(carried.usage.input).toBe(5000)
    expect(carried.usage.output).toBe(2000)
    expect(carried.estimatedCost).toBe(0.50)
    expect(carried.previousSessions).toEqual([TEST_SESSION])

    // verify it was persisted
    const loaded = await loadSessionCost(TEST_SESSION_2)
    expect(loaded.estimatedCost).toBe(0.50)
    expect(loaded.previousSessions).toEqual([TEST_SESSION])
  })

  test('saveSessionCost and loadSessionCost round-trip', async () => {
    const cost = {
      usage: { input: 100, output: 200, cacheRead: 50, cacheWrite: 25 },
      estimatedCost: 0.01,
      previousSessions: ['old-1', 'old-2'],
    }
    await saveSessionCost(TEST_SESSION, cost)
    const loaded = await loadSessionCost(TEST_SESSION)
    expect(loaded).toEqual(cost)
  })
})
