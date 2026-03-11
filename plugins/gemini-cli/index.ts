import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult, ToolContext, Message } from '../../server/types.ts'
import { mkdir, readdir, stat, symlink, access } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getDataDir } from '../../server/session.ts'

const LOG_DIR = join(getDataDir(), 'gemini-cli')
const PENDING_PATH = join(LOG_DIR, 'pending.json')

// --- pending session persistence ---

async function readPending(): Promise<string[]> {
  try {
    const file = Bun.file(PENDING_PATH)
    if (!(await file.exists())) return []
    return await file.json()
  } catch {
    return []
  }
}

async function writePending(ids: string[]): Promise<void> {
  await Bun.write(PENDING_PATH, JSON.stringify(ids, null, 2))
}

async function addPending(sessionId: string): Promise<void> {
  const ids = await readPending()
  if (!ids.includes(sessionId)) {
    ids.push(sessionId)
    await writePending(ids)
  }
}

async function removePending(sessionId: string): Promise<void> {
  const ids = await readPending()
  const filtered = ids.filter(id => id !== sessionId)
  await writePending(filtered)
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

// --- types ---

interface ProcessInfo {
  proc: ReturnType<typeof Bun.spawn>
  pid: number
  task: string
  worktree?: string
  originalWorkingDir?: string
}

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
  /** Gemini CLI's own session ID (from stream-json init event). */
  geminiSessionId?: string
}

// --- file helpers ---

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

// --- queued message types ---

interface QueuedMessage {
  message: Message
  outputTarget?: string
}

interface GeminiCliConfig {
  notifyTarget?: string
  worktreeBase?: string
  /** Default model for gemini CLI. Defaults to "auto" (Gemini's smart routing). */
  model?: string
}

// --- worktree merge logic (shared with claude-code pattern) ---

async function handleWorktreeMerge(
  worktree: string,
  originalWorkingDir: string,
  sessionId: string,
  taskPreview: string,
  logPath: string,
  taskStatus: string,
  worktreeBase: string,
  spawnConflictResolver?: (task: string, cwd: string) => void,
): Promise<string> {
  const worktreePath = join(worktreeBase, worktree)

  const mergeResult = Bun.spawnSync(
    ['git', 'merge', worktree],
    { cwd: originalWorkingDir }
  )

  if (mergeResult.exitCode === 0) {
    console.log(`[gemini-cli] merge of ${worktree} succeeded, cleaning up`)
    Bun.spawnSync(['git', 'worktree', 'remove', worktreePath], { cwd: originalWorkingDir })
    Bun.spawnSync(['git', 'branch', '-d', worktree], { cwd: originalWorkingDir })

    return `[Gemini CLI task ${taskStatus} — worktree merged successfully]\nSession: ${sessionId}\nTask: ${taskPreview}\nBranch "${worktree}" merged and cleaned up.\nLog: ${logPath}\n\nUse read_gemini_cli_output to review the results.`
  }

  // merge failed — likely conflict
  const mergeStderr = mergeResult.stderr.toString().trim()
  const mergeStdout = mergeResult.stdout.toString().trim()
  const conflictOutput = [mergeStdout, mergeStderr].filter(Boolean).join('\n')

  console.log(`[gemini-cli] merge of ${worktree} failed, spawning conflict resolver`)

  const conflictTask = `There's a merge conflict from branch "${worktree}". Resolve it, keeping changes from both sides where possible. Run \`git add\` on resolved files and \`git commit\` to complete the merge.\n\nConflict output:\n${conflictOutput}`

  if (spawnConflictResolver) {
    spawnConflictResolver(conflictTask, originalWorkingDir)
  }

  return `[Gemini CLI task ${taskStatus} — merge conflict]\nSession: ${sessionId}\nTask: ${taskPreview}\nBranch "${worktree}" had merge conflicts. A conflict resolution session has been spawned in ${originalWorkingDir}.\nThe worktree at ${worktreePath} has NOT been removed (branch still exists for reference).\nLog: ${logPath}\n\nUse read_gemini_cli_output to review the results.`
}

// --- plugin factory ---

export default function create(): Plugin {
  let config: GeminiCliConfig | null = null
  const messageQueue: QueuedMessage[] = []
  let resolveWaiter: (() => void) | null = null

  function queueNotification(text: string) {
    console.log('[gemini-cli] queueNotification called:', text.slice(0, 100))
    messageQueue.push({
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
      outputTarget: config?.notifyTarget,
    })
    if (resolveWaiter) {
      resolveWaiter()
      resolveWaiter = null
    }
  }

  /** Fire-and-forget spawn of a gemini cli session (used for conflict resolution). */
  function spawnGeminiCli(task: string, cwd: string) {
    const sid = generateSessionId()
    const lp = getLogPath(sid)
    const model = config?.model ?? 'auto'

    ensureLogDir().then(async () => {
      const meta: MetaFile = {
        sessionId: sid,
        task,
        workingDir: cwd,
        startedAt: new Date().toISOString(),
        pid: 0,
      }

      const geminiArgs = ['gemini', '-p', task, '-y', '-o', 'stream-json', '-m', model]

      const proc = Bun.spawn(geminiArgs, {
        cwd,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })

      meta.pid = proc.pid
      await writeMeta(meta)
      await addPending(sid)
      runningProcesses.set(sid, { proc, pid: proc.pid, task })

      console.log(`[gemini-cli] spawned conflict resolver session ${sid} (pid ${proc.pid})`)

      // pipe stdout to log, capture session ID from init event
      pipeStdoutToLog(proc, lp, meta)

      // drain stderr
      drainStderr(proc)

      proc.exited.then(async (code) => {
        runningProcesses.delete(sid)
        meta.exitCode = code ?? 1
        meta.endedAt = new Date().toISOString()
        await writeMeta(meta)
        await removePending(sid)

        const status = code === 0 ? 'completed successfully' : `failed with exit code ${code}`
        const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task
        queueNotification(
          `[Gemini CLI conflict resolution ${status}]\nSession: ${sid}\nTask: ${taskPreview}\nLog: ${lp}\n\nUse read_gemini_cli_output to review the results.`
        )
      }).catch((err) => {
        console.error(`[gemini-cli] conflict resolver proc.exited rejected for ${sid}:`, err)
      })
    }).catch((err) => {
      console.error(`[gemini-cli] failed to spawn conflict resolver:`, err)
    })
  }

  /**
   * Pipe a spawned process's stdout to a log file, capturing the Gemini session ID
   * from the first `init` event in the stream-json output.
   */
  function pipeStdoutToLog(
    proc: ReturnType<typeof Bun.spawn>,
    logPath: string,
    meta: MetaFile,
  ) {
    ;(async () => {
      const logFile = Bun.file(logPath)
      const writer = logFile.writer()
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader()
      const decoder = new TextDecoder()
      let initParsed = false
      let leftover = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          writer.write(value)

          // parse init event from first line(s) if not yet done
          if (!initParsed) {
            leftover += decoder.decode(value, { stream: true })
            const newlineIdx = leftover.indexOf('\n')
            if (newlineIdx !== -1) {
              initParsed = true
              const firstLine = leftover.slice(0, newlineIdx)
              try {
                const parsed = JSON.parse(firstLine)
                // Gemini stream-json emits {"type":"init","session_id":"...",...}
                if (parsed.type === 'init' && parsed.session_id) {
                  meta.geminiSessionId = parsed.session_id
                  await writeMeta(meta)
                  console.log(`[gemini-cli] captured Gemini session ID: ${parsed.session_id}`)
                }
              } catch { /* not valid JSON — continue */ }
              leftover = ''
            }
          }
        }
      } catch (err) {
        console.error(`[gemini-cli] stdout pipe error for ${meta.sessionId}:`, err)
      } finally {
        writer.end()
      }
    })()
  }

  function drainStderr(proc: ReturnType<typeof Bun.spawn>) {
    ;(async () => {
      const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader()
      try {
        while (true) {
          const { done } = await reader.read()
          if (done) break
        }
      } catch { /* ignore */ }
    })()
  }

  async function* inputGenerator(): AsyncGenerator<QueuedMessage> {
    while (true) {
      while (messageQueue.length > 0) {
        yield messageQueue.shift()!
      }
      await new Promise<void>(resolve => {
        resolveWaiter = resolve
      })
    }
  }

  async function handleSessionCompletion(meta: MetaFile): Promise<void> {
    const logPath = getLogPath(meta.sessionId)

    if (!meta.endedAt) {
      // process died while we were down — infer exit status from log
      let exitCode = 1
      try {
        const logContent = await Bun.file(logPath).text()
        const lines = logContent.split('\n').filter(l => l.trim())
        for (let i = lines.length - 1; i >= 0; i--) {
          try {
            const parsed = JSON.parse(lines[i]!)
            if (parsed.type === 'result') {
              exitCode = parsed.status === 'success' ? 0 : 1
              break
            }
          } catch { continue }
        }
      } catch { /* log might not exist */ }

      meta.exitCode = exitCode
      meta.endedAt = new Date().toISOString()
      await writeMeta(meta)
    }

    await removePending(meta.sessionId)

    const status = meta.exitCode === 0 ? 'completed successfully' : `failed with exit code ${meta.exitCode}`
    const taskPreview = meta.task.length > 100 ? meta.task.slice(0, 100) + '...' : meta.task

    // handle worktree merge if applicable
    if (meta.worktree && meta.originalWorkingDir) {
      const wtBase = config?.worktreeBase
        ? config.worktreeBase.replace(/^~/, homedir())
        : join(homedir(), 'code', 'toebeans-wt')
      const mergeMsg = await handleWorktreeMerge(
        meta.worktree, meta.originalWorkingDir, meta.sessionId, taskPreview, logPath, status, wtBase,
        (conflictTask, conflictCwd) => {
          spawnGeminiCli(conflictTask, conflictCwd)
        },
      )
      queueNotification(mergeMsg)
    } else {
      queueNotification(
        `[Gemini CLI task ${status}]\nSession: ${meta.sessionId}\nTask: ${taskPreview}\nLog: ${logPath}\n\nUse read_gemini_cli_output to review the results.`
      )
    }
  }

  function pollForExit(meta: MetaFile): void {
    const interval = setInterval(async () => {
      if (!isProcessAlive(meta.pid)) {
        clearInterval(interval)
        console.log(`[gemini-cli] polled session ${meta.sessionId} (pid ${meta.pid}) — process exited`)
        await handleSessionCompletion(meta)
      }
    }, 2000)
  }

  async function reattachPendingSessions(): Promise<void> {
    const pendingIds = await readPending()
    if (pendingIds.length === 0) return

    console.log(`[gemini-cli] reattaching ${pendingIds.length} pending session(s): ${pendingIds.join(', ')}`)

    for (const sessionId of pendingIds) {
      const meta = await readMeta(sessionId)
      if (!meta) {
        console.log(`[gemini-cli] no meta for pending session ${sessionId}, removing`)
        await removePending(sessionId)
        continue
      }

      if (meta.endedAt) {
        console.log(`[gemini-cli] pending session ${sessionId} already has endedAt, sending notification`)
        await handleSessionCompletion(meta)
        continue
      }

      if (!isProcessAlive(meta.pid)) {
        console.log(`[gemini-cli] pending session ${sessionId} (pid ${meta.pid}) is no longer alive`)
        await handleSessionCompletion(meta)
        continue
      }

      // still running — poll for exit
      console.log(`[gemini-cli] pending session ${sessionId} (pid ${meta.pid}) still running, polling`)
      pollForExit(meta)
    }
  }

  // --- tools ---

  const tools: Tool[] = [
    {
      name: 'spawn_gemini_cli',
      description: 'Spawn a new Gemini CLI session with a one-shot task. Returns session ID and log file path. You will be notified when the task completes. Can resume a previous Gemini session using resumeSessionIndex.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task/prompt to send to Gemini CLI' },
          workingDir: { type: 'string', description: 'Working directory for the Gemini CLI process (optional). Tilde (~) is expanded to the home directory.' },
          worktree: { type: 'string', description: 'Branch/task name for git worktree isolation. When provided with workingDir, creates a git worktree and runs the task there. The branch is merged back on completion.' },
          resumeSessionIndex: { type: 'string', description: 'Gemini session index or "latest" to resume a previous session in the same project directory. Note: Gemini CLI uses index-based session references, not UUIDs.' },
        },
        required: ['task'],
      },
      pathFields: ['workingDir'],
      async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
        const { task, workingDir, worktree, resumeSessionIndex } = input as {
          task: string
          workingDir?: string
          worktree?: string
          resumeSessionIndex?: string
        }

        await ensureLogDir()
        const sessionId = generateSessionId()
        const logPath = getLogPath(sessionId)
        const originalCwd = workingDir ?? context.workingDir
        let cwd = originalCwd

        try {
          // check for uncommitted changes before creating a worktree
          if (workingDir && worktree) {
            const statusResult = Bun.spawnSync(
              ['git', 'status', '--porcelain'],
              { cwd: workingDir }
            )
            const dirtyFiles = statusResult.stdout.toString().trim()
            if (dirtyFiles) {
              return {
                content: `Cannot spawn worktree: repo has uncommitted changes. Commit or stash first: git status in ${workingDir}`,
                is_error: true,
              }
            }
          }

          // set up git worktree if requested
          if (worktree) {
            if (!workingDir) {
              return { content: 'worktree requires workingDir to be set (need a git repo to branch from)', is_error: true }
            }

            const worktreeBase = config?.worktreeBase
              ? config.worktreeBase.replace(/^~/, homedir())
              : join(homedir(), 'code', 'toebeans-wt')
            const worktreePath = join(worktreeBase, worktree)
            await mkdir(worktreeBase, { recursive: true })

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
            console.log(`[gemini-cli] created worktree at ${worktreePath} for branch ${worktree}`)
          }

          // write metadata
          const meta: MetaFile = {
            sessionId,
            task,
            workingDir: cwd,
            startedAt: new Date().toISOString(),
            pid: 0,
            worktree,
            originalWorkingDir: worktree ? originalCwd : undefined,
          }

          // build gemini command
          // Gemini CLI: gemini -p <prompt> -o stream-json -y -m <model>
          // -p: one-shot prompt mode (like claude -p)
          // -y: auto-approve all tool calls (like --dangerously-skip-permissions)
          // -o stream-json: structured streaming output (like --output-format stream-json)
          const geminiModel = config?.model ?? 'auto'
          const geminiArgs = ['gemini']
          if (resumeSessionIndex) {
            geminiArgs.push('-r', resumeSessionIndex)
          }
          geminiArgs.push('-p', task, '-y', '-o', 'stream-json', '-m', geminiModel)

          const proc = Bun.spawn(geminiArgs, {
            cwd,
            env: { ...process.env },
            stdout: 'pipe',
            stderr: 'pipe',
          })

          meta.pid = proc.pid
          await writeMeta(meta)
          await addPending(sessionId)

          // pipe stdout to log, capture Gemini session ID
          pipeStdoutToLog(proc, logPath, meta)

          // drain stderr
          drainStderr(proc)

          runningProcesses.set(sessionId, {
            proc, pid: proc.pid, task, worktree,
            originalWorkingDir: worktree ? originalCwd : undefined,
          })

          // notify on exit
          proc.exited.then(async (code) => {
            console.log(`[gemini-cli] proc.exited fired for ${sessionId}, exit code: ${code}`)

            try {
              runningProcesses.delete(sessionId)

              meta.exitCode = code ?? 1
              meta.endedAt = new Date().toISOString()
              await writeMeta(meta)
              await removePending(sessionId)

              const status = code === 0 ? 'completed successfully' : `failed with exit code ${code}`
              const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task

              if (worktree && meta.originalWorkingDir) {
                const wtBase = config?.worktreeBase
                  ? config.worktreeBase.replace(/^~/, homedir())
                  : join(homedir(), 'code', 'toebeans-wt')
                const mergeMsg = await handleWorktreeMerge(
                  worktree, meta.originalWorkingDir, sessionId, taskPreview, logPath, status, wtBase,
                  (conflictTask, conflictCwd) => {
                    spawnGeminiCli(conflictTask, conflictCwd)
                  },
                )
                queueNotification(mergeMsg)
              } else {
                queueNotification(
                  `[Gemini CLI task ${status}]\nSession: ${sessionId}\nTask: ${taskPreview}\nLog: ${logPath}\n\nUse read_gemini_cli_output to review the results.`
                )
              }
            } catch (err) {
              console.error(`[gemini-cli] error in exit handler for ${sessionId}:`, err)
              try {
                const status = code === 0 ? 'completed successfully' : `failed with exit code ${code}`
                const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task
                queueNotification(
                  `[Gemini CLI task ${status}]\nSession: ${sessionId}\nTask: ${taskPreview}\nLog: ${logPath}\n\nUse read_gemini_cli_output to review the results.`
                )
              } catch (notifyErr) {
                console.error(`[gemini-cli] failed to queue notification for ${sessionId}:`, notifyErr)
              }
            }
          }).catch((err) => {
            console.error(`[gemini-cli] proc.exited promise rejected for ${sessionId}:`, err)
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
          return { content: `Failed to spawn gemini cli: ${error.message}`, is_error: true }
        }
      },
    },

    {
      name: 'list_gemini_cli_sessions',
      description: 'List recent Gemini CLI sessions with their status.',
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
      name: 'read_gemini_cli_output',
      description: 'Read output from a Gemini CLI session log. Returns a clean, readable summary by default, or raw stream-json with raw=true.',
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

          // parse and summarize — adapted for Gemini's stream-json format
          const summaries: string[] = []

          for (const line of tailLines) {
            if (!line.trim()) continue

            try {
              const parsed = JSON.parse(line)

              if (parsed.type === 'message' && parsed.role === 'assistant') {
                // assistant message (potentially delta)
                if (parsed.content) {
                  summaries.push(`assistant: ${parsed.content}`)
                }
              } else if (parsed.type === 'message' && parsed.role === 'user') {
                summaries.push('user: [message]')
              } else if (parsed.type === 'tool_use') {
                summaries.push(`[tool: ${parsed.tool_name}]`)
              } else if (parsed.type === 'tool_result') {
                const statusLabel = parsed.status === 'success' ? 'ok' : parsed.status
                const preview = typeof parsed.output === 'string'
                  ? parsed.output.slice(0, 200) + (parsed.output.length > 200 ? '...' : '')
                  : ''
                summaries.push(`[tool result: ${statusLabel}] ${preview}`.trim())
              } else if (parsed.type === 'result') {
                // final result event
                const parts: string[] = ['result:']
                if (parsed.status) parts.push(parsed.status)
                if (parsed.stats?.duration_ms != null) parts.push(`${parsed.stats.duration_ms}ms`)
                if (parsed.stats?.total_tokens != null) parts.push(`${parsed.stats.total_tokens} tokens`)
                summaries.push(parts.join(' '))
              } else if (parsed.type === 'init') {
                summaries.push(`[session: ${parsed.session_id ?? 'unknown'}, model: ${parsed.model ?? 'unknown'}]`)
              }
              // skip other event types
            } catch {
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
    name: 'gemini-cli',
    description: `Spawn one-shot Gemini CLI tasks and monitor their output. You are automatically notified when tasks complete.

Differences from claude-code:
- Session resume uses index numbers or "latest" (not UUIDs). Gemini sessions are per-project (per working directory).
- The default model is "auto" (Gemini's smart routing between flash-lite and pro). Can be overridden to "pro", "flash", "flash-lite", or specific model names.
- No --fork-session equivalent; resume continues the existing session in-place.
- Requires GEMINI_API_KEY or Google OAuth configured in ~/.gemini/.`,

    tools,
    input: inputGenerator(),

    async init(cfg: unknown) {
      config = cfg as GeminiCliConfig
      console.log('[gemini-cli] initialized with config:', config)
      await ensureLogDir()
      await reattachPendingSessions()
    },
  }
}
