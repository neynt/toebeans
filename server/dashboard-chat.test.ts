import { describe, test, expect } from 'bun:test'
import { routeFromSessionId, sanitizeRoute } from './session.ts'

describe('routeFromSessionId', () => {
  test('extracts route prefix from routed session ID', () => {
    expect(routeFromSessionId('discord-dm-alice-2026-04-01-0000')).toBe('discord-dm-alice')
  })

  test('returns empty string for unrouted session ID', () => {
    expect(routeFromSessionId('2026-04-01-0000')).toBe('')
  })

  test('handles complex route prefixes', () => {
    expect(routeFromSessionId('discord-999999999999999999-2026-03-15-0003')).toBe('discord-999999999999999999')
  })

  test('returns empty string for malformed session ID', () => {
    expect(routeFromSessionId('not-a-session-id')).toBe('')
  })

  test('roundtrips with sanitizeRoute for common routes', () => {
    const route = 'discord:dm-alice'
    const sanitized = sanitizeRoute(route)
    const sessionId = `${sanitized}-2026-04-01-0000`
    expect(routeFromSessionId(sessionId)).toBe(sanitized)
  })
})
