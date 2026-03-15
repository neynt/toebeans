import { homedir } from 'os'
import { join } from 'path'

const PIDFILE_PATH = join(homedir(), '.toebeans', 'server.pid')

/** Check if a process with the given PID is alive. */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Acquire the pidfile lock. Returns true if acquired, false if another
 * live instance holds it. Stale pidfiles (dead PID) are overwritten.
 */
export async function acquirePidfile(): Promise<boolean> {
  const file = Bun.file(PIDFILE_PATH)
  if (await file.exists()) {
    const contents = (await file.text()).trim()
    const pid = parseInt(contents, 10)
    if (!isNaN(pid) && isProcessAlive(pid)) {
      return false
    }
    // stale pidfile — fall through and overwrite
  }
  await Bun.write(PIDFILE_PATH, String(process.pid))
  return true
}

/** Remove the pidfile if it contains our PID. */
export async function releasePidfile(): Promise<void> {
  try {
    const file = Bun.file(PIDFILE_PATH)
    if (await file.exists()) {
      const contents = (await file.text()).trim()
      const pid = parseInt(contents, 10)
      if (pid === process.pid) {
        const { unlink } = await import('node:fs/promises')
        await unlink(PIDFILE_PATH)
      }
    }
  } catch {
    // best-effort cleanup
  }
}

export { PIDFILE_PATH }
