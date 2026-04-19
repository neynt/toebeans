import { describe, test, expect } from 'bun:test'
import { buildDiscordRoute, sanitizeDiscordName } from './routes.ts'

describe('buildDiscordRoute', () => {
  test('builds stable guild routes with sanitized names and channel id', () => {
    expect(buildDiscordRoute('999999999999999999', false, 'alice', 'Example Guild', 'general chat')).toBe(
      'discord:example-guild-general-chat-999999999999999999',
    )
  })

  test('builds stable DM routes with sanitized username and channel id', () => {
    expect(buildDiscordRoute('123', true, 'Al!ice')).toBe('discord:dm-al-ice-123')
  })

  test('sanitizeDiscordName collapses punctuation runs', () => {
    expect(sanitizeDiscordName('  Foo__Bar!!Baz  ')).toBe('foo-bar-baz')
  })
})
