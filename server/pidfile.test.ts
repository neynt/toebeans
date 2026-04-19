import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { acquirePidfile, releasePidfile, PIDFILE_PATH } from './pidfile.ts'
import { unlink, writeFile, readFile } from 'node:fs/promises'

async function cleanup() {
  try { await unlink(PIDFILE_PATH) } catch {}
}

describe('pidfile', () => {
  beforeEach(cleanup)
  afterEach(cleanup)

  test('acquires when no pidfile exists', async () => {
    expect(await acquirePidfile()).toBe(true)
    const contents = await readFile(PIDFILE_PATH, 'utf-8')
    expect(contents.trim()).toBe(String(process.pid))
  })

  test('rejects when live process holds pidfile', async () => {
    // write our own PID — we're alive
    await writeFile(PIDFILE_PATH, String(process.pid))
    // a second acquire should fail (same PID = still alive)
    expect(await acquirePidfile()).toBe(false)
  })

  test('overwrites stale pidfile (dead PID)', async () => {
    // PID 2147483647 is almost certainly not running
    await writeFile(PIDFILE_PATH, '2147483647')
    expect(await acquirePidfile()).toBe(true)
    const contents = await readFile(PIDFILE_PATH, 'utf-8')
    expect(contents.trim()).toBe(String(process.pid))
  })

  test('overwrites pidfile with garbage contents', async () => {
    await writeFile(PIDFILE_PATH, 'not-a-pid')
    expect(await acquirePidfile()).toBe(true)
  })

  test('release removes pidfile when it contains our PID', async () => {
    await writeFile(PIDFILE_PATH, String(process.pid))
    await releasePidfile()
    const file = Bun.file(PIDFILE_PATH)
    expect(await file.exists()).toBe(false)
  })

  test('release does not remove pidfile owned by another PID', async () => {
    await writeFile(PIDFILE_PATH, '1')  // PID 1 (init) — not us
    await releasePidfile()
    const file = Bun.file(PIDFILE_PATH)
    expect(await file.exists()).toBe(true)
  })
})
