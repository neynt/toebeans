/**
 * Shared status scanning for coding agent plugins (claude-code, gemini-cli, openai-codex).
 *
 * All three use the same pattern: .meta.json files in a log directory with
 * sessionId, task, workingDir, startedAt, pid, exitCode?, endedAt?, worktree?.
 */

import { readdir } from 'node:fs/promises'
import { join } from 'path'
import type { PluginStatus, PluginStatusTask } from '../server/plugin.ts'

/** Common fields every coding agent meta file has. */
export interface CodingAgentMeta {
  sessionId: string
  task: string
  workingDir: string
  startedAt: string
  pid: number
  exitCode?: number
  endedAt?: string
  worktree?: string
  [key: string]: unknown
}

/** A recently completed task (superset of PluginStatusTask with end info). */
export interface RecentTask extends PluginStatusTask {
  endedAt: string
  exitCode?: number
}

export interface CodingAgentStatus extends PluginStatus {
  tasks?: PluginStatusTask[]
  recentTasks?: RecentTask[]
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Scan a log directory for .meta.json files and return active + recent tasks.
 * @param logDir — directory containing .meta.json files
 * @param recentLimit — max number of recent completed tasks to return (default 10)
 * @param recentMaxAge — max age in ms for recent tasks (default 24h)
 */
export async function getCodingAgentStatus(
  logDir: string,
  recentLimit = 10,
  recentMaxAge = 24 * 60 * 60 * 1000,
): Promise<CodingAgentStatus | null> {
  try {
    const files = await readdir(logDir)
    const metaFiles = files.filter(f => f.endsWith('.meta.json'))

    const active: PluginStatusTask[] = []
    const recent: RecentTask[] = []
    const now = Date.now()

    for (const file of metaFiles) {
      try {
        const meta: CodingAgentMeta = await Bun.file(join(logDir, file)).json()

        if (!meta.endedAt) {
          // possibly still running
          if (isProcessAlive(meta.pid)) {
            active.push({
              id: meta.sessionId,
              description: meta.task,
              startedAt: meta.startedAt,
              workingDir: meta.workingDir,
              worktree: meta.worktree,
            })
          }
        } else {
          // completed — include if recent enough
          const age = now - new Date(meta.endedAt).getTime()
          if (age <= recentMaxAge) {
            recent.push({
              id: meta.sessionId,
              description: meta.task,
              startedAt: meta.startedAt,
              endedAt: meta.endedAt,
              exitCode: meta.exitCode,
              workingDir: meta.workingDir,
              worktree: meta.worktree,
            })
          }
        }
      } catch { /* skip bad meta */ }
    }

    active.sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    recent.sort((a, b) => new Date(b.endedAt!).getTime() - new Date(a.endedAt!).getTime())

    const trimmedRecent = recent.slice(0, recentLimit)

    if (active.length === 0 && trimmedRecent.length === 0) return null
    return {
      tasks: active.length > 0 ? active : undefined,
      recentTasks: trimmedRecent.length > 0 ? trimmedRecent : undefined,
    }
  } catch {
    return null
  }
}
