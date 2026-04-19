import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { writeFile, mkdir, rm } from 'fs/promises'
import { join } from 'path'
import { getActiveSessions, CODING_AGENTS, formatPluginStatuses, type CodingAgentMeta } from './index.ts'
import type { PluginStatus } from '../../server/plugin.ts'
import { getDataDir } from '../../server/session.ts'

describe('CODING_AGENTS', () => {
  test('includes all three coding agents', () => {
    const names = CODING_AGENTS.map(a => a.name)
    expect(names).toContain('Claude Code')
    expect(names).toContain('Gemini CLI')
    expect(names).toContain('OpenAI Codex')
  })

  test('each agent has emoji and dir', () => {
    for (const agent of CODING_AGENTS) {
      expect(agent.emoji).toBeTruthy()
      expect(agent.dir).toBeTruthy()
    }
  })

  test('dirs match expected subdirectories', () => {
    const dirs = CODING_AGENTS.map(a => a.dir)
    expect(dirs).toEqual(['claude-code', 'gemini-cli', 'openai-codex'])
  })
})

describe('getActiveSessions', () => {
  const testDir = join(getDataDir(), '_test-coding-agent')

  beforeEach(async () => {
    await mkdir(testDir, { recursive: true })
  })

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true })
  })

  test('returns empty array when directory does not exist', async () => {
    const sessions = await getActiveSessions('_nonexistent-agent-dir')
    expect(sessions).toEqual([])
  })

  test('returns empty array when no meta files exist', async () => {
    const sessions = await getActiveSessions('_test-coding-agent')
    expect(sessions).toEqual([])
  })

  test('skips sessions with endedAt set', async () => {
    const meta: CodingAgentMeta = {
      sessionId: 'test-ended',
      task: 'some task',
      workingDir: '/tmp',
      startedAt: new Date().toISOString(),
      pid: process.pid,
      endedAt: new Date().toISOString(),
    }
    await writeFile(join(testDir, 'test-ended.meta.json'), JSON.stringify(meta))
    const sessions = await getActiveSessions('_test-coding-agent')
    expect(sessions).toEqual([])
  })

  test('returns sessions for alive processes', async () => {
    const meta: CodingAgentMeta = {
      sessionId: 'test-active',
      task: 'an active task',
      workingDir: '/tmp',
      startedAt: new Date().toISOString(),
      pid: process.pid, // current process is alive
    }
    await writeFile(join(testDir, 'test-active.meta.json'), JSON.stringify(meta))
    const sessions = await getActiveSessions('_test-coding-agent')
    expect(sessions).toHaveLength(1)
    expect(sessions[0].sessionId).toBe('test-active')
    expect(sessions[0].task).toBe('an active task')
  })

  test('skips sessions with dead pids', async () => {
    const meta: CodingAgentMeta = {
      sessionId: 'test-dead',
      task: 'dead task',
      workingDir: '/tmp',
      startedAt: new Date().toISOString(),
      pid: 999999999, // almost certainly not a real process
    }
    await writeFile(join(testDir, 'test-dead.meta.json'), JSON.stringify(meta))
    const sessions = await getActiveSessions('_test-coding-agent')
    expect(sessions).toEqual([])
  })

  test('sorts by startedAt descending (newest first)', async () => {
    const now = Date.now()
    for (const [id, offset] of [['older', -60000], ['newer', 0]] as const) {
      const meta: CodingAgentMeta = {
        sessionId: id,
        task: `task ${id}`,
        workingDir: '/tmp',
        startedAt: new Date(now + offset).toISOString(),
        pid: process.pid,
      }
      await writeFile(join(testDir, `${id}.meta.json`), JSON.stringify(meta))
    }
    const sessions = await getActiveSessions('_test-coding-agent')
    expect(sessions).toHaveLength(2)
    expect(sessions[0].sessionId).toBe('newer')
    expect(sessions[1].sessionId).toBe('older')
  })
})

describe('formatPluginStatuses', () => {
  test('returns empty string for empty statuses', () => {
    const result = formatPluginStatuses(new Map())
    expect(result).toBe('')
  })

  test('returns empty string when statuses have no tasks', () => {
    const statuses = new Map<string, PluginStatus>([
      ['claude-code', { tasks: [] }],
    ])
    const result = formatPluginStatuses(statuses)
    expect(result).toBe('')
  })

  test('formats known coding agent with correct emoji and display name', () => {
    const now = new Date()
    const statuses = new Map<string, PluginStatus>([
      ['claude-code', {
        tasks: [{
          id: 'session-1',
          description: 'fix the bug',
          startedAt: now.toISOString(),
        }],
      }],
    ])
    const result = formatPluginStatuses(statuses)
    expect(result).toContain('🖥️')
    expect(result).toContain('Claude Code')
    expect(result).toContain('`session-1`')
    expect(result).toContain('fix the bug')
  })

  test('truncates long task descriptions at 60 chars', () => {
    const longDesc = 'a'.repeat(80)
    const statuses = new Map<string, PluginStatus>([
      ['claude-code', {
        tasks: [{
          id: 'x',
          description: longDesc,
          startedAt: new Date().toISOString(),
        }],
      }],
    ])
    const result = formatPluginStatuses(statuses)
    expect(result).toContain('a'.repeat(60) + '...')
    expect(result).not.toContain('a'.repeat(61))
  })

  test('uses fallback emoji for unknown plugins', () => {
    const statuses = new Map<string, PluginStatus>([
      ['my-custom-plugin', {
        tasks: [{
          id: 'task-1',
          description: 'doing things',
          startedAt: new Date().toISOString(),
        }],
      }],
    ])
    const result = formatPluginStatuses(statuses)
    expect(result).toContain('🔌')
    expect(result).toContain('my-custom-plugin')
  })

  test('formats multiple plugins', () => {
    const now = new Date().toISOString()
    const statuses = new Map<string, PluginStatus>([
      ['claude-code', { tasks: [{ id: 'cc-1', description: 'task a', startedAt: now }] }],
      ['bash', { tasks: [{ id: '1234', description: 'npm run build', startedAt: now }] }],
    ])
    const result = formatPluginStatuses(statuses)
    expect(result).toContain('Claude Code')
    expect(result).toContain('🐚')
    expect(result).toContain('Bash')
  })

  test('shows age in minutes', () => {
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    const statuses = new Map<string, PluginStatus>([
      ['claude-code', { tasks: [{ id: 'x', description: 'y', startedAt: tenMinutesAgo }] }],
    ])
    const result = formatPluginStatuses(statuses)
    expect(result).toContain('(10m)')
  })
})
