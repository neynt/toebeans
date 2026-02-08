import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult, ToolContext, Message } from '../../server/types.ts'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const LOG_DIR = join(homedir(), '.toebeans', 'codex')

interface ProcessInfo {
  proc: ReturnType<typeof Bun.spawn>
  pid: number
  task: string
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
  sessionId: string
  message: Message
  outputTarget?: string
}

interface OpenAICodexConfig {
  notifyTarget?: string
}

export default function createOpenAICodexPlugin(): Plugin {
  let config: OpenAICodexConfig | null = null
  const messageQueue: QueuedMessage[] = []
  let resolveWaiter: (() => void) | null = null

  function queueNotification(text: string) {
    console.log('[openai-codex] queueNotification called:', text.slice(0, 100))
    messageQueue.push({
      sessionId: 'openai-codex',
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

  const tools: Tool[] = [
    {
      name: 'spawn_codex',
      description: 'Spawn a new OpenAI Codex CLI session with a one-shot task. Returns session ID and log file path. You will be notified when the task completes.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task/prompt to send to Codex' },
          workingDir: { type: 'string', description: 'Working directory for the codex process (optional)' },
          model: { type: 'string', description: 'Model to use (optional, e.g. "o3", "o4-mini")' },
        },
        required: ['task'],
      },
      async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
        const { task, workingDir, model } = input as { task: string; workingDir?: string; model?: string }

        await ensureLogDir()
        const sessionId = generateSessionId()
        const logPath = getLogPath(sessionId)
        const cwd = workingDir ?? context.workingDir

        try {
          const meta: MetaFile = {
            sessionId,
            task,
            workingDir: cwd,
            startedAt: new Date().toISOString(),
            pid: 0,
          }

          // build codex exec command
          let cmd = 'exec codex exec --dangerously-bypass-approvals-and-sandbox'
          if (model) {
            cmd += ` -m "$CODEX_MODEL"`
          }
          cmd += ' -- "$CODEX_TASK" > "$CODEX_LOG" 2>&1'

          const env: Record<string, string> = {
            ...process.env as Record<string, string>,
            CODEX_TASK: task,
            CODEX_LOG: logPath,
          }
          if (model) {
            env.CODEX_MODEL = model
          }

          const proc = Bun.spawn(
            ['sh', '-c', cmd],
            {
              cwd,
              env,
              stdout: 'ignore',
              stderr: 'ignore',
            }
          )

          meta.pid = proc.pid
          await writeMeta(meta)

          runningProcesses.set(sessionId, { proc, pid: proc.pid, task })

          proc.exited.then(async (code) => {
            try {
              runningProcesses.delete(sessionId)

              meta.exitCode = code ?? 1
              meta.endedAt = new Date().toISOString()
              await writeMeta(meta)

              const status = code === 0 ? 'completed successfully' : `failed with exit code ${code}`
              const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task
              queueNotification(
                `[Codex task ${status}]\nSession: ${sessionId}\nTask: ${taskPreview}\nLog: ${logPath}\n\nUse read_codex_output to review the results.`
              )
            } catch (err) {
              console.error(`[openai-codex] error in exit handler for ${sessionId}:`, err)
              try {
                const status = code === 0 ? 'completed successfully' : `failed with exit code ${code}`
                const taskPreview = task.length > 100 ? task.slice(0, 100) + '...' : task
                queueNotification(
                  `[Codex task ${status}]\nSession: ${sessionId}\nTask: ${taskPreview}\nLog: ${logPath}\n\nUse read_codex_output to review the results.`
                )
              } catch (notifyErr) {
                console.error(`[openai-codex] failed to queue notification for ${sessionId}:`, notifyErr)
              }
            }
          }).catch((err) => {
            console.error(`[openai-codex] proc.exited promise rejected for ${sessionId}:`, err)
          })

          return {
            content: JSON.stringify({
              sessionId,
              logPath,
              pid: proc.pid,
              status: 'started',
            }, null, 2)
          }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `Failed to spawn codex: ${error.message}`, is_error: true }
        }
      },
    },

    {
      name: 'list_codex_sessions',
      description: 'List recent OpenAI Codex sessions with their status.',
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
      name: 'read_codex_output',
      description: 'Read output from an OpenAI Codex session log. Returns the tail of the log output.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session ID to read' },
          tail: { type: 'number', description: 'How many lines to read from end of log (default: 50)' },
        },
        required: ['sessionId'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { sessionId, tail = 50 } = input as { sessionId: string; tail?: number }

        const logPath = getLogPath(sessionId)
        const file = Bun.file(logPath)

        if (!(await file.exists())) {
          return { content: `session log not found: ${sessionId}`, is_error: true }
        }

        try {
          const content = await file.text()
          const lines = content.split('\n')
          const tailLines = tail ? lines.slice(-tail) : lines

          const output = tailLines.join('\n').trim()
          if (!output) {
            return { content: 'no output found in log' }
          }

          return { content: output }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `failed to read session: ${error.message}`, is_error: true }
        }
      },
    },
  ]

  return {
    name: 'openai-codex',
    description: `Spawn one-shot OpenAI Codex CLI tasks and monitor their output. You are automatically notified when tasks complete.`,

    tools,
    input: inputGenerator(),

    async init(cfg: unknown) {
      config = cfg as OpenAICodexConfig
      console.log('[openai-codex] initialized with config:', config)
      await ensureLogDir()
    },
  }
}
