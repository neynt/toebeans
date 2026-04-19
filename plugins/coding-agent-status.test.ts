import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { getCodingAgentStatus } from './coding-agent-status.ts'
import { mkdir, rm } from 'node:fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'

const TEST_DIR = join(tmpdir(), 'toebeans-test-coding-agent-status-' + Date.now())

beforeEach(async () => {
  await mkdir(TEST_DIR, { recursive: true })
})

afterEach(async () => {
  await rm(TEST_DIR, { recursive: true, force: true })
})

async function writeMeta(id: string, meta: Record<string, unknown>) {
  await Bun.write(join(TEST_DIR, `${id}.meta.json`), JSON.stringify(meta))
}

describe('getCodingAgentStatus', () => {
  test('returns null for empty directory', async () => {
    const result = await getCodingAgentStatus(TEST_DIR)
    expect(result).toBeNull()
  })

  test('returns null for nonexistent directory', async () => {
    const result = await getCodingAgentStatus('/tmp/does-not-exist-' + Date.now())
    expect(result).toBeNull()
  })

  test('returns recent completed tasks', async () => {
    const now = new Date()
    await writeMeta('sess1', {
      sessionId: 'sess1',
      task: 'fix bug',
      workingDir: '/code/repo',
      startedAt: new Date(now.getTime() - 60000).toISOString(),
      pid: 99999999,
      exitCode: 0,
      endedAt: new Date(now.getTime() - 30000).toISOString(),
    })

    const result = await getCodingAgentStatus(TEST_DIR)
    expect(result).not.toBeNull()
    expect(result!.tasks).toBeUndefined()
    expect(result!.recentTasks).toHaveLength(1)
    expect(result!.recentTasks![0].id).toBe('sess1')
    expect(result!.recentTasks![0].exitCode).toBe(0)
    expect(result!.recentTasks![0].endedAt).toBeDefined()
  })

  test('excludes tasks older than recentMaxAge', async () => {
    const now = new Date()
    await writeMeta('old-sess', {
      sessionId: 'old-sess',
      task: 'ancient task',
      workingDir: '/code/repo',
      startedAt: new Date(now.getTime() - 100000).toISOString(),
      pid: 99999999,
      exitCode: 0,
      endedAt: new Date(now.getTime() - 90000).toISOString(),
    })

    // 1 second max age — too old
    const result = await getCodingAgentStatus(TEST_DIR, 10, 1000)
    expect(result).toBeNull()
  })

  test('respects recentLimit', async () => {
    const now = new Date()
    for (let i = 0; i < 5; i++) {
      await writeMeta(`sess${i}`, {
        sessionId: `sess${i}`,
        task: `task ${i}`,
        workingDir: '/code/repo',
        startedAt: new Date(now.getTime() - 60000 - i * 1000).toISOString(),
        pid: 99999999,
        exitCode: 0,
        endedAt: new Date(now.getTime() - 30000 - i * 1000).toISOString(),
      })
    }

    const result = await getCodingAgentStatus(TEST_DIR, 3)
    expect(result!.recentTasks).toHaveLength(3)
  })

  test('sorts recent tasks by endedAt descending', async () => {
    const now = new Date()
    await writeMeta('older', {
      sessionId: 'older',
      task: 'older task',
      workingDir: '/code/repo',
      startedAt: new Date(now.getTime() - 120000).toISOString(),
      pid: 99999999,
      exitCode: 0,
      endedAt: new Date(now.getTime() - 60000).toISOString(),
    })
    await writeMeta('newer', {
      sessionId: 'newer',
      task: 'newer task',
      workingDir: '/code/repo',
      startedAt: new Date(now.getTime() - 30000).toISOString(),
      pid: 99999999,
      exitCode: 0,
      endedAt: new Date(now.getTime() - 10000).toISOString(),
    })

    const result = await getCodingAgentStatus(TEST_DIR)
    expect(result!.recentTasks![0].id).toBe('newer')
    expect(result!.recentTasks![1].id).toBe('older')
  })

  test('identifies active tasks by alive PID', async () => {
    // use our own PID — guaranteed alive
    await writeMeta('active', {
      sessionId: 'active',
      task: 'running task',
      workingDir: '/code/repo',
      startedAt: new Date().toISOString(),
      pid: process.pid,
    })

    const result = await getCodingAgentStatus(TEST_DIR)
    expect(result!.tasks).toHaveLength(1)
    expect(result!.tasks![0].id).toBe('active')
  })

  test('skips active tasks with dead PID', async () => {
    await writeMeta('dead', {
      sessionId: 'dead',
      task: 'dead task',
      workingDir: '/code/repo',
      startedAt: new Date().toISOString(),
      pid: 99999999, // not alive
    })

    const result = await getCodingAgentStatus(TEST_DIR)
    expect(result).toBeNull()
  })

  test('includes worktree field when present', async () => {
    await writeMeta('wt-sess', {
      sessionId: 'wt-sess',
      task: 'worktree task',
      workingDir: '/code/repo',
      startedAt: new Date().toISOString(),
      pid: process.pid,
      worktree: 'feature-branch',
    })

    const result = await getCodingAgentStatus(TEST_DIR)
    expect(result!.tasks![0].worktree).toBe('feature-branch')
  })

  test('skips malformed meta files', async () => {
    await Bun.write(join(TEST_DIR, 'bad.meta.json'), 'not json{{{')

    const result = await getCodingAgentStatus(TEST_DIR)
    expect(result).toBeNull()
  })
})
