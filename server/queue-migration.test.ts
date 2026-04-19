import { describe, test, expect } from 'bun:test'
import { migrateQueuedMessages, type QueuedMessage } from './queue-migration.ts'

function msg(text: string, outputTarget = 'discord:123', metadata?: Record<string, unknown>): QueuedMessage {
  return { content: [{ type: 'text', text }], outputTarget, metadata }
}

describe('migrateQueuedMessages', () => {
  test('returns empty and clears the old entry when no queued messages exist', () => {
    const queues = new Map<string, QueuedMessage[]>()
    const migrated = migrateQueuedMessages('old', 'new', queues)
    expect(migrated).toEqual([])
    expect(queues.has('old')).toBe(false)
    expect(queues.has('new')).toBe(false)
  })

  test('removes an empty queue entry without creating one on the successor', () => {
    const queues = new Map<string, QueuedMessage[]>([['old', []]])
    const migrated = migrateQueuedMessages('old', 'new', queues)
    expect(migrated).toEqual([])
    expect(queues.has('old')).toBe(false)
    expect(queues.has('new')).toBe(false)
  })

  test('moves all queued messages from old to new session', () => {
    const queues = new Map<string, QueuedMessage[]>([
      ['old', [msg('hey'), msg('you there?')]],
    ])
    const migrated = migrateQueuedMessages('old', 'new', queues)
    expect(migrated).toEqual([msg('hey'), msg('you there?')])
    expect(queues.has('old')).toBe(false)
    expect(queues.get('new')).toEqual([msg('hey'), msg('you there?')])
  })

  test('appends migrated messages after any existing successor queue', () => {
    const queues = new Map<string, QueuedMessage[]>([
      ['old', [msg('from-old-1'), msg('from-old-2')]],
      ['new', [msg('already-on-new')]],
    ])
    const migrated = migrateQueuedMessages('old', 'new', queues)
    expect(migrated).toEqual([msg('from-old-1'), msg('from-old-2')])
    expect(queues.has('old')).toBe(false)
    expect(queues.get('new')).toEqual([
      msg('already-on-new'),
      msg('from-old-1'),
      msg('from-old-2'),
    ])
  })

  test('preserves per-message metadata so dequeued notifications can still fire', () => {
    const queues = new Map<string, QueuedMessage[]>([
      ['old', [msg('hi', 'discord:1', { discordMessageId: 'abc' })]],
    ])
    migrateQueuedMessages('old', 'new', queues)
    const [migrated] = queues.get('new')!
    expect(migrated!.metadata).toEqual({ discordMessageId: 'abc' })
    expect(migrated!.outputTarget).toBe('discord:1')
  })
})
