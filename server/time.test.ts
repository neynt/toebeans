import { describe, test, expect, beforeEach } from 'bun:test'
import { setTimezone, formatLocalTime, formatLocalTimeOnly, formatLocalDate, formatLocalFilenameTimestamp } from './time.ts'

describe('time formatting', () => {
  beforeEach(() => {
    setTimezone('America/New_York')
  })

  const winter = new Date('2024-01-15T18:30:45Z') // 1:30 PM EST
  const summer = new Date('2024-07-15T18:30:45Z') // 2:30 PM EDT

  test('formatLocalDate returns YYYY-MM-DD in local timezone', () => {
    expect(formatLocalDate(winter)).toBe('2024-01-15')
    expect(formatLocalDate(summer)).toBe('2024-07-15')
  })

  test('formatLocalDate respects timezone for date boundary', () => {
    // 3 AM UTC on Jan 2 = 10 PM EST on Jan 1
    const nearMidnight = new Date('2024-01-02T03:00:00Z')
    expect(formatLocalDate(nearMidnight)).toBe('2024-01-01')
  })

  test('formatLocalTimeOnly includes timezone abbreviation', () => {
    expect(formatLocalTimeOnly(winter)).toMatch(/13:30:45 EST/)
    expect(formatLocalTimeOnly(summer)).toMatch(/14:30:45 EDT/)
  })

  test('formatLocalTime combines date and time', () => {
    expect(formatLocalTime(winter)).toBe('2024-01-15 13:30:45 EST')
  })

  test('formatLocalFilenameTimestamp returns filename-safe local time', () => {
    const result = formatLocalFilenameTimestamp(winter)
    expect(result).toMatch(/^2024-01-15_13-30-45$/)
    // no colons or spaces
    expect(result).not.toContain(':')
    expect(result).not.toContain(' ')
  })

  test('formatLocalFilenameTimestamp uses configured timezone', () => {
    setTimezone('Asia/Tokyo') // UTC+9
    // 18:30 UTC = 03:30 next day JST
    const result = formatLocalFilenameTimestamp(winter)
    expect(result).toMatch(/^2024-01-16_03-30-45$/)
  })
})
