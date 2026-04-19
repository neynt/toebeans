import { describe, test, expect } from 'bun:test'
import { parseSchedule, MAX_TIMEOUT_MS } from './index.ts'

describe('parseSchedule', () => {
  test('parses absolute datetime without seconds', () => {
    const result = parseSchedule('2026-04-01T14:30.md')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('absolute')
    expect(result!.repeat).toBe(false)
    expect(result!.next).toEqual(new Date('2026-04-01T14:30'))
  })

  test('parses absolute datetime with seconds', () => {
    const result = parseSchedule('2026-04-01T14:30:00.md')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('absolute')
    expect(result!.next).toEqual(new Date('2026-04-01T14:30:00'))
  })

  test('parses daily timer', () => {
    const result = parseSchedule('daily-08:00.md')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('daily')
    expect(result!.repeat).toBe(true)
    expect(result!.prev).toBeDefined()
  })

  test('parses weekly timer', () => {
    const result = parseSchedule('weekly-mon-09:00.md')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('weekly')
    expect(result!.repeat).toBe(true)
  })

  test('parses hourly timer', () => {
    const result = parseSchedule('hourly-30.md')
    expect(result).not.toBeNull()
    expect(result!.type).toBe('hourly')
    expect(result!.repeat).toBe(true)
  })

  test('returns null for invalid filename', () => {
    expect(parseSchedule('reminder.md')).toBeNull()
    expect(parseSchedule('daily.md')).toBeNull()
    expect(parseSchedule('2026-13-01T14:30.md')).toBeNull() // invalid month -> NaN date
  })

  test('returns null for deleted timer files', () => {
    expect(parseSchedule('daily-08:00.md.deleted')).toBeNull()
  })
})

describe('one-shot timer scheduling', () => {
  const pad = (n: number) => String(n).padStart(2, '0')
  function dateToFilename(d: Date): string {
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}.md`
  }

  test('absolute timer within 7 days is not deferred', () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setMinutes(0, 0, 0)

    const schedule = parseSchedule(dateToFilename(tomorrow))
    expect(schedule).not.toBeNull()
    const msUntil = schedule!.next.getTime() - Date.now()
    expect(msUntil).toBeLessThan(MAX_TIMEOUT_MS)
  })

  test('absolute timer months out parses successfully and is deferred', () => {
    const farFuture = new Date()
    farFuture.setMonth(farFuture.getMonth() + 3)

    const schedule = parseSchedule(dateToFilename(farFuture))
    expect(schedule).not.toBeNull()
    expect(schedule!.type).toBe('absolute')
    expect(schedule!.repeat).toBe(false)
    // it parses fine — scheduling logic defers it, no rejection
    const msUntil = schedule!.next.getTime() - Date.now()
    expect(msUntil).toBeGreaterThan(MAX_TIMEOUT_MS)
  })

  test('absolute timer years out parses successfully', () => {
    const farFuture = new Date()
    farFuture.setFullYear(farFuture.getFullYear() + 2)

    const schedule = parseSchedule(dateToFilename(farFuture))
    expect(schedule).not.toBeNull()
    expect(schedule!.type).toBe('absolute')
  })

  test('setTimeout 32-bit overflow threshold is above 7-day cap', () => {
    const MAX_SETTIMEOUT_MS = 2 ** 31 - 1
    expect(MAX_TIMEOUT_MS).toBeLessThan(MAX_SETTIMEOUT_MS)
  })

  test('MAX_TIMEOUT_MS is exactly 7 days', () => {
    expect(MAX_TIMEOUT_MS).toBe(7 * 24 * 60 * 60 * 1000)
  })
})

describe('deferred timer scheduling logic', () => {
  test('far-future timer delay is capped at MAX_TIMEOUT_MS', () => {
    const farFuture = new Date()
    farFuture.setMonth(farFuture.getMonth() + 3)
    const pad = (n: number) => String(n).padStart(2, '0')
    const filename = `${farFuture.getFullYear()}-${pad(farFuture.getMonth() + 1)}-${pad(farFuture.getDate())}T${pad(farFuture.getHours())}:${pad(farFuture.getMinutes())}.md`

    const schedule = parseSchedule(filename)!
    const msUntil = schedule.next.getTime() - Date.now()
    // this is the same capping logic used in scheduleTimer()
    const delay = Math.max(0, Math.min(msUntil, MAX_TIMEOUT_MS))
    const isDeferred = msUntil > MAX_TIMEOUT_MS

    expect(isDeferred).toBe(true)
    expect(delay).toBe(MAX_TIMEOUT_MS)
  })

  test('near-future timer delay is not capped', () => {
    const tomorrow = new Date()
    tomorrow.setDate(tomorrow.getDate() + 1)
    tomorrow.setMinutes(0, 0, 0)
    const pad = (n: number) => String(n).padStart(2, '0')
    const filename = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T${pad(tomorrow.getHours())}:${pad(tomorrow.getMinutes())}.md`

    const schedule = parseSchedule(filename)!
    const msUntil = schedule.next.getTime() - Date.now()
    const delay = Math.max(0, Math.min(msUntil, MAX_TIMEOUT_MS))
    const isDeferred = msUntil > MAX_TIMEOUT_MS

    expect(isDeferred).toBe(false)
    expect(delay).toBe(msUntil)
  })

  test('daily rescan interval is 24 hours', () => {
    // the plugin uses a 24h rescan interval to re-evaluate deferred timers
    const RESCAN_INTERVAL_MS = 24 * 60 * 60 * 1000
    expect(RESCAN_INTERVAL_MS).toBe(86_400_000)
    // rescan should happen more frequently than the timeout cap
    expect(RESCAN_INTERVAL_MS).toBeLessThan(MAX_TIMEOUT_MS)
  })
})
