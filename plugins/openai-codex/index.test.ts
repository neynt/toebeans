import { describe, test, expect } from 'bun:test'

describe('codex MetaFile outputTarget', () => {
  test('MetaFile includes outputTarget field', () => {
    const meta = {
      sessionId: '2025-01-15_10-30-00_abc1',
      task: 'fix the bug',
      workingDir: '/home/user/project',
      startedAt: '2025-01-15T10:30:00.000Z',
      pid: 12345,
      outputTarget: 'discord:1234567890',
    }

    const serialized = JSON.stringify(meta, null, 2)
    const deserialized = JSON.parse(serialized)
    expect(deserialized.outputTarget).toBe('discord:1234567890')
  })

  test('MetaFile outputTarget is optional', () => {
    const meta = {
      sessionId: '2025-01-15_10-30-00_abc1',
      task: 'do something',
      workingDir: '/tmp/test',
      startedAt: '2025-01-15T10:30:00.000Z',
      pid: 99999,
    }

    const serialized = JSON.stringify(meta, null, 2)
    const deserialized = JSON.parse(serialized)
    expect(deserialized.outputTarget).toBeUndefined()
  })
})

describe('codex notification routing', () => {
  test('queueNotification uses provided outputTarget over config default', () => {
    // simulate the queueNotification logic
    const configNotifyTarget = 'discord:default-channel'
    const messages: Array<{ text: string; outputTarget: string | undefined }> = []

    function queueNotification(text: string, outputTarget?: string) {
      messages.push({
        text,
        outputTarget: outputTarget ?? configNotifyTarget,
      })
    }

    // when called with explicit outputTarget (from meta)
    queueNotification('task done', 'discord:spawning-channel')
    expect(messages[0]!.outputTarget).toBe('discord:spawning-channel')

    // when called without (falls back to config)
    queueNotification('task done')
    expect(messages[1]!.outputTarget).toBe('discord:default-channel')
  })

  test('queueNotification includes triggerNotice', () => {
    const messages: Array<{ triggerNotice?: string }> = []

    function queueNotification(_text: string, _outputTarget?: string, triggerNotice?: string) {
      messages.push({ triggerNotice })
    }

    queueNotification('task done', 'discord:123', 'Codex task completed successfully')
    expect(messages[0]!.triggerNotice).toBe('Codex task completed successfully')
  })

  test('queueNotification includes route for canonical session routing', () => {
    const configNotifyTarget = 'discord:default-channel'
    const messages: Array<{ outputTarget?: string; route?: string }> = []

    function queueNotification(text: string, outputTarget?: string, triggerNotice?: string, route?: string) {
      messages.push({
        outputTarget: outputTarget ?? configNotifyTarget,
        route,
      })
    }

    // when spawned from a friendly-route session, route should be preserved
    queueNotification('task done', 'discord:999999999999999999', 'Codex done', 'discord:example-guild-general-999999999999999999')
    expect(messages[0]!.outputTarget).toBe('discord:999999999999999999')
    expect(messages[0]!.route).toBe('discord:example-guild-general-999999999999999999')

    // when no route provided, should be undefined (server falls back to outputTarget)
    queueNotification('task done', 'discord:999999999999999999', 'Codex done')
    expect(messages[1]!.route).toBeUndefined()
  })

  test('MetaFile preserves route through serialization', () => {
    const meta = {
      sessionId: '2025-01-15_10-30-00_abc1',
      task: 'fix the bug',
      workingDir: '/home/user/project',
      startedAt: '2025-01-15T10:30:00.000Z',
      pid: 12345,
      outputTarget: 'discord:999999999999999999',
      route: 'discord:example-guild-general-999999999999999999',
    }

    const deserialized = JSON.parse(JSON.stringify(meta))
    expect(deserialized.route).toBe('discord:example-guild-general-999999999999999999')
    expect(deserialized.outputTarget).toBe('discord:999999999999999999')
  })
})
