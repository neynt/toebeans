import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult, ToolContext, Message } from '../../server/types.ts'
import { mkdir, readdir, stat, symlink, access } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getDataDir } from '../../server/session.ts'

const LOG_DIR = join(getDataDir(), 'claude-code')
const WORKTREE_BASE = join(homedir(), 'code', 'toebeans-wt')

interface ProcessInfo {
  proc: ReturnType<typeof Bun.spawn>
  pid: number
  task: string
  worktree?: string
  originalWorkingDir?: string
}

// track running processes by session id
const runningProcesses = new Map<string, ProcessInfo>()

interface MetaFile {
  sessionId: string
  task: string
  workingDir: string
  startedAt: string
  pid: number
  exitCode?: number
  endedAt?: string
  worktree?: string
  originalWorkingDir?: string
}

async function ensureLogDir(): Promise<void> {
  await mkdir(LOG_DIR, { recursive: true })
}

function generateSessionId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10)
  const time = now.toISOString().slice(11, 19).replace(/:/g, '-')
  const rand = Math.random().toString(36).slice(2, 6)
  return `${date}_${time}_${rand}`
}

function getLogPath(sessionId: string): string {
  return join(LOG_DIR, `${sessionId}.log`)
}

function getMetaPath(sessionId: string): string {
  return join(LOG_DIR, `${sessionId}.meta.json`)
}

async function readMeta(sessionId: string): Promise<MetaFile | null> {
  try {
    const file = Bun.file(getMetaPath(sessionId))
    if (!(await file.exists())) return null
    return await file.json()
  } catch {
    return null
  }
}

async function writeMeta(meta: MetaFile): Promise<void> {
  await Bun.write(getMetaPath(meta.sessionId), JSON.stringify(meta, null, 2))
}

interface QueuedMessage {
  message: Message
  outputTarget?: string
}

interface ClaudeCodeConfig {
  notifyTarget?: string
}

/**
 * After a worktree task completes, merge the branch back and clean up.
 * If there's a conflict, spawn a new claude code session to resolve it.
 * Returns the notification message to queue.
 */
async function handleWorktreeMerge(
  worktree: string,
  originalWorkingDir: string,
  sessionId: string,
  taskPreview: string,
  logPath: string,
  taskStatus: string,
  spawnConflictResolver?: (task: string, cwd: string) => void,
): Promise<string> {
  const worktreePath = join(WORKTREE_BASE, worktree)

  // attempt merge
  const mergeResult = Bun.spawnSync(
    ['git', 'merge', worktree],
    { cwd: originalWorkingDir }
  )

  if (mergeResult.exitCode === 0) {
    // merge succeeded — clean up worktree and branch
    console.log(`[claude-code] merge of ${worktree} succeeded, cleaning up`)

    Bun.spawnSync(['git', 'worktree', 'remove', worktreePath], { cwd: originalWorkingDir })
    Bun.spawnSync(['git', 'branch', '-d', worktree], { cwd: originalWorkingDir })

    return `[Claude Code task ${taskStatus} — worktree merged successfully]\nSession: ${sessionId}\nTask: ${taskPreview}\nBranch "${worktree}" merged and cleaned up.\nLog: ${logPath}\n\nUse read_claude_code_output to review the results.`
  }

  // merge failed — likely conflict
  const mergeStderr = mergeResult.stderr.toString().trim()
  const mergeStdout = mergeResult.stdout.toString().trim()
  const conflictOutput = [mergeStdout, mergeStderr].filter(Boolean).join('\n')

  console.log(`[claude-code] merge of ${worktree} failed, spawning conflict resolver`)

  const conflictTask = `There's a merge conflict from branch "${worktree}". Resolve it, keeping changes from both sides where possible. Run \`git add\` on resolved files and \`git commit\` to complete the merge.\n\nConflict output:\n${conflictOutput}`

  if (spawnConflictResolver) {
    spawnConflictResolver(conflictTask, originalWorkingDir)
  }

  return `[Claude Code task ${taskStatus} — merge conflict]\nSession: ${sessionId}\nTask: ${taskPreview}\nBranch "${worktree}" had merge conflicts. A conflict resolution session has been spawned in ${originalWorkingDir}.\nThe worktree at ${worktreePath} has NOT been removed (branch still exists for reference).\nLog: ${logPath}\n\nUse read_claude_code_output to review the results.`
}

export default function createClaudeCodePlugin(): Plugin {
  let config: ClaudeCodeConfig | null = null
  const messageQueue: QueuedMessage[] = []
  let resolveWaiter: (() => void) | null = null

  function queueNotification(text: string) {
    console.log('[claude-code] queueNotification called:', text.slice(0, 100))
    messageQueue.push({
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
      outputTarget: config?.notifyTarget,
    })
    console.log('[claude-code] messageQueue.length:', messageQueue.length)
    if (resolveWaiter) {
      console.log('[claude-code] resolving waiter')
      resolveWaiter()
      resolveWaiter = null
    } else {
      console.log('[claude-code] no waiter to resolve')
    }
  }

  /** Fire-and-forget spawn of a claude code session (used for conflict resolution). */
  function spawnClaudeCode(task: string, cwd: string) {
    const sid = generateSessionId()
    const lp = getLogPath(sid)

    ensureLogDir().then(async () => {
      const meta: MetaFile = {
        sessionId: sid,
        task,
        workingDir: cwd,
        startedAt: new Date().toISOString(),
        pid: 0,
      }

      const proc = Bun.spawn(
        ['sh', '-c', 'exec claude -p --dangerously-skip-permissions --output-format stream-json --verbose --model opus -- "$CLAUDE_TASK" > "$CLAUDE_LOG" 2>&1'],
        {
          cwd,
          env: { ...process.env, CLAUDE_TASK: task, CLAUDE_LOG: lp },
          stdout: 'ignore',
          stderr: 'ignore',
        }
      )

      meta.pid = proc.pid
      await writeMeta(meta)
      runningProcesses.set(sid, { proc, pid: proc.pid, task })

      console.log(`[claude-code] spawned conflict resolver session ${sid} (pid ${proc.pid})`)

      proc.exited.then(async (code) => {
        runningProcesses.delete(sid)
        meta.exitCode = code ?? 1
        meta.endedAt = new Date().toISOString()
        await writeMeta(meta)

        const status = code === 0 ? 'completed successfully' : `failed with exit code ${code}`
        const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task
        queueNotification(
          `[Claude Code conflict resolution ${status}]\nSession: ${sid}\nTask: ${taskPreview}\nLog: ${lp}\n\nUse read_claude_code_output to review the results.`
        )
      }).catch((err) => {
        console.error(`[claude-code] conflict resolver proc.exited rejected for ${sid}:`, err)
      })
    }).catch((err) => {
      console.error(`[claude-code] failed to spawn conflict resolver:`, err)
    })
  }

  async function* inputGenerator(): AsyncGenerator<QueuedMessage> {
    console.log('[claude-code] inputGenerator started')
    while (true) {
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift()!
        const firstContent = msg.message.content[0]
        const preview = firstContent && 'text' in firstContent ? firstContent.text.slice(0, 100) : '(no text)'
        console.log('[claude-code] yielding message:', preview)
        yield msg
      }
      console.log('[claude-code] waiting for next message')
      await new Promise<void>(resolve => {
        resolveWaiter = resolve
      })
      console.log('[claude-code] waiter resolved, checking queue')
    }
  }

  const tools: Tool[] = [
    {
      name: 'spawn_claude_code',
      description: 'Spawn a new Claude Code session with a one-shot task. Returns session ID and log file path. You will be notified when the task completes.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task/prompt to send to Claude Code' },
          workingDir: { type: 'string', description: 'Working directory for the claude code process (optional)' },
          worktree: { type: 'string', description: 'Branch/task name for git worktree isolation. When provided with workingDir, creates a git worktree and runs the task there. The branch is merged back on completion.' },
        },
        required: ['task'],
      },
      async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
        const { task, workingDir, worktree } = input as { task: string; workingDir?: string; worktree?: string }

        await ensureLogDir()
        const sessionId = generateSessionId()
        const logPath = getLogPath(sessionId)
        const originalCwd = workingDir ?? context.workingDir
        let cwd = originalCwd

        try {
          // set up git worktree if requested
          if (worktree) {
            if (!workingDir) {
              return { content: 'worktree requires workingDir to be set (need a git repo to branch from)', is_error: true }
            }

            const worktreePath = join(WORKTREE_BASE, worktree)
            await mkdir(WORKTREE_BASE, { recursive: true })

            // create the worktree + branch
            const wtResult = Bun.spawnSync(
              ['git', 'worktree', 'add', worktreePath, '-b', worktree],
              { cwd: workingDir }
            )

            if (wtResult.exitCode !== 0) {
              const stderr = wtResult.stderr.toString().trim()
              return { content: `Failed to create git worktree: ${stderr}`, is_error: true }
            }

            // symlink node_modules if the repo has a package.json
            const worktreePkg = Bun.file(join(worktreePath, 'package.json'))
            const originalNodeModules = join(workingDir, 'node_modules')
            if (await worktreePkg.exists()) {
              try {
                await access(originalNodeModules)
                await symlink(originalNodeModules, join(worktreePath, 'node_modules'))
              } catch {
                // no node_modules in original — skip
              }
            }

            cwd = worktreePath
            console.log(`[claude-code] created worktree at ${worktreePath} for branch ${worktree}`)
          }

          // write metadata
          const meta: MetaFile = {
            sessionId,
            task,
            workingDir: cwd,
            startedAt: new Date().toISOString(),
            pid: 0, // updated after spawn
            worktree: worktree,
            originalWorkingDir: worktree ? originalCwd : undefined,
          }

          // spawn claude with stdout/stderr redirected to log file via shell
          // this way claude writes directly to the file — survives toebeans dying
          const proc = Bun.spawn(
            ['sh', '-c', 'exec claude -p --dangerously-skip-permissions --output-format stream-json --verbose --model opus -- "$CLAUDE_TASK" > "$CLAUDE_LOG" 2>&1'],
            {
              cwd,
              env: { ...process.env, CLAUDE_TASK: task, CLAUDE_LOG: logPath },
              stdout: 'ignore',
              stderr: 'ignore',
            }
          )

          meta.pid = proc.pid
          await writeMeta(meta)

          runningProcesses.set(sessionId, { proc, pid: proc.pid, task, worktree, originalWorkingDir: worktree ? originalCwd : undefined })

          // notify when done (best-effort — only works if toebeans is still alive)
          console.log(`[claude-code] registering exit handler for session ${sessionId}`)
          proc.exited.then(async (code) => {
            console.log(`[claude-code] proc.exited fired for ${sessionId}, exit code: ${code}`)

            try {
              runningProcesses.delete(sessionId)

              // update meta with exit info
              meta.exitCode = code ?? 1
              meta.endedAt = new Date().toISOString()
              await writeMeta(meta)
              console.log(`[claude-code] wrote meta for ${sessionId}`)

              const status = code === 0 ? 'completed successfully' : `failed with exit code ${code}`
              const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task

              // handle worktree merge if applicable
              if (worktree && meta.originalWorkingDir) {
                const mergeMsg = await handleWorktreeMerge(
                  worktree, meta.originalWorkingDir, sessionId, taskPreview, logPath, status,
                  (conflictTask, conflictCwd) => {
                    // spawn a new claude code session to resolve the conflict
                    spawnClaudeCode(conflictTask, conflictCwd)
                  },
                )
                queueNotification(mergeMsg)
              } else {
                queueNotification(
                  `[Claude Code task ${status}]\nSession: ${sessionId}\nTask: ${taskPreview}\nLog: ${logPath}\n\nUse read_claude_code_output to review the results.`
                )
              }
            } catch (err) {
              console.error(`[claude-code] error in exit handler for ${sessionId}:`, err)
              try {
                const status = code === 0 ? 'completed successfully' : `failed with exit code ${code}`
                const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task
                queueNotification(
                  `[Claude Code task ${status}]\nSession: ${sessionId}\nTask: ${taskPreview}\nLog: ${logPath}\n\nUse read_claude_code_output to review the results.`
                )
              } catch (notifyErr) {
                console.error(`[claude-code] failed to queue notification for ${sessionId}:`, notifyErr)
              }
            }
          }).catch((err) => {
            console.error(`[claude-code] proc.exited promise rejected for ${sessionId}:`, err)
          })

          const result: Record<string, unknown> = {
            sessionId,
            logPath,
            pid: proc.pid,
            status: 'started',
          }
          if (worktree) {
            result.worktree = worktree
            result.worktreePath = cwd
          }

          return { content: JSON.stringify(result, null, 2) }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `Failed to spawn claude code: ${error.message}`, is_error: true }
        }
      },
    },

    {
      name: 'list_claude_code_sessions',
      description: 'List recent Claude Code sessions with their status.',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Max number of sessions to show (default: 10)' },
        },
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { limit = 10 } = input as { limit?: number }

        await ensureLogDir()

        try {
          const files = await readdir(LOG_DIR)
          const metaFiles = files.filter(f => f.endsWith('.meta.json'))

          const sessions = await Promise.all(
            metaFiles.map(async (file) => {
              const sessionId = file.replace('.meta.json', '')
              const meta = await readMeta(sessionId)
              if (!meta) return null

              const logPath = getLogPath(sessionId)
              const logFile = Bun.file(logPath)
              const logExists = await logFile.exists()

              // determine status
              let status = 'completed'
              if (meta.endedAt) {
                status = meta.exitCode === 0 ? 'completed' : 'failed'
              } else {
                // no endedAt — check if process is still running
                const running = runningProcesses.get(sessionId)
                if (running) {
                  try {
                    process.kill(running.pid, 0)
                    status = 'running'
                  } catch {
                    status = 'unknown'
                    runningProcesses.delete(sessionId)
                  }
                } else {
                  // not tracked in memory — check if pid is alive
                  try {
                    process.kill(meta.pid, 0)
                    status = 'running'
                  } catch {
                    status = 'unknown'
                  }
                }
              }

              let size = 0
              let mtime = new Date(meta.startedAt)
              if (logExists) {
                const logStat = await stat(logPath)
                size = logStat.size
                mtime = logStat.mtime
              }

              return {
                sessionId,
                status,
                exitCode: meta.exitCode,
                task: meta.task.slice(0, 100) + (meta.task.length > 100 ? '...' : ''),
                startedAt: meta.startedAt,
                endedAt: meta.endedAt,
                pid: meta.pid,
                logSizeBytes: size,
                mtime,
              }
            })
          )

          const valid = sessions.filter(Boolean) as NonNullable<(typeof sessions)[number]>[]
          valid.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

          const result = valid.slice(0, limit).map(({ mtime, ...rest }) => rest)
          return { content: JSON.stringify(result, null, 2) }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `Failed to list sessions: ${error.message}`, is_error: true }
        }
      },
    },

    {
      name: 'read_claude_code_output',
      description: 'Read output from a Claude Code session log. Returns a clean, readable summary by default, or raw stream-json with raw=true.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session ID to read' },
          tail: { type: 'number', description: 'How many lines to read from end of log (default: 5)' },
          raw: { type: 'boolean', description: 'Return raw stream-json instead of summary (default: false)' },
        },
        required: ['sessionId'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { sessionId, tail = 5, raw = false } = input as { sessionId: string; tail?: number; raw?: boolean }

        const logPath = getLogPath(sessionId)
        const file = Bun.file(logPath)

        if (!(await file.exists())) {
          return { content: `session log not found: ${sessionId}`, is_error: true }
        }

        try {
          const content = await file.text()
          const lines = content.split('\n').filter(l => l.trim())
          const tailLines = tail ? lines.slice(-tail) : lines

          if (raw) {
            return { content: tailLines.join('\n') }
          }

          // parse and summarize
          const summaries: string[] = []

          for (const line of tailLines) {
            if (!line.trim()) continue

            try {
              const parsed = JSON.parse(line)

              if (parsed.type === 'assistant') {
                // extract text and tool uses from assistant messages
                const parts: string[] = []
                if (parsed.message?.content) {
                  for (const block of parsed.message.content) {
                    if (block.type === 'text' && block.text) {
                      parts.push(block.text)
                    } else if (block.type === 'tool_use') {
                      parts.push(`[tool: ${block.name}]`)
                    }
                  }
                }
                if (parts.length > 0) {
                  summaries.push(`assistant: ${parts.join(' ')}`)
                }
              } else if (parsed.type === 'user') {
                // user messages are typically tool results - just summarize
                const hasResults = parsed.message?.content?.some((b: { type: string }) => b.type === 'tool_result')
                summaries.push(hasResults ? 'user: [tool results]' : 'user: [message]')
              } else if (parsed.type === 'result') {
                // final result
                const parts: string[] = ['result:']
                if (parsed.result) parts.push(parsed.result)
                if (parsed.is_error) parts.push('(error)')
                if (parsed.duration_ms != null) parts.push(`${parsed.duration_ms}ms`)
                if (parsed.cost != null) parts.push(`$${parsed.cost.toFixed(4)}`)
                summaries.push(parts.join(' '))
              } else if (parsed.type === 'status') {
                // status updates
                if (parsed.status) {
                  summaries.push(`status: ${parsed.status}`)
                }
              }
              // skip other types (system, etc)
            } catch {
              // malformed json - skip silently
              continue
            }
          }

          if (summaries.length === 0) {
            return { content: 'no parseable output found in log' }
          }

          return { content: summaries.join('\n\n') }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `failed to read session: ${error.message}`, is_error: true }
        }
      },
    },
  ]

  return {
    name: 'claude-code',
    description: `Spawn one-shot Claude Code tasks and monitor their output. You are automatically notified when tasks complete.`,

    tools,
    input: inputGenerator(),

    async init(cfg: unknown) {
      config = cfg as ClaudeCodeConfig
      console.log('[claude-code] initialized with config:', config)
      await ensureLogDir()
    },
  }
}
