import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult, ToolContext, Message } from '../../server/types.ts'
import { resolve } from 'path'
import { homedir } from 'os'
import { join } from 'path'
import { mkdir } from 'node:fs/promises'

const DEFAULT_TIMEOUT_S = 60
const MAX_TIMEOUT_S = 600
const SPAWN_DEFAULT_TIMEOUT_S = 600
const SPAWN_MAX_TIMEOUT_S = 3600

const BASH_LOGS_DIR = join(homedir(), '.toebeans', 'bash-logs')

interface SpawnedProcess {
  proc: ReturnType<typeof Bun.spawn>
  pid: number
  command: string
  logPath: string
  startedAt: string
}

const spawnedProcesses = new Map<number, SpawnedProcess>()

async function ensureBashLogsDir(): Promise<void> {
  await mkdir(BASH_LOGS_DIR, { recursive: true })
}

function generateLogFilename(): string {
  const now = new Date()
  const timestamp = now.toISOString().replace(/[:.]/g, '-')
  return `${timestamp}.log`
}

async function readLastLines(filePath: string, lineCount: number): Promise<string> {
  try {
    const file = Bun.file(filePath)
    if (!(await file.exists())) return '(log file not found)'
    const content = await file.text()
    const lines = content.split('\n')
    const lastLines = lines.slice(-lineCount).filter(l => l.trim())
    return lastLines.join('\n') || '(empty log)'
  } catch {
    return '(failed to read log)'
  }
}

export default function createBashPlugin(): Plugin {
  const messageQueue: { sessionId: string; message: Message; outputTarget?: string }[] = []
  let resolveWaiter: (() => void) | null = null

  function queueNotification(text: string) {
    messageQueue.push({
      sessionId: 'bash-spawn',
      message: {
        role: 'user',
        content: [{ type: 'text', text }],
      },
    })
    if (resolveWaiter) {
      resolveWaiter()
      resolveWaiter = null
    }
  }

  async function* inputGenerator(): AsyncGenerator<{ sessionId: string; message: Message; outputTarget?: string }> {
    while (true) {
      while (messageQueue.length > 0) {
        const msg = messageQueue.shift()!
        yield msg
      }
      await new Promise<void>(resolve => {
        resolveWaiter = resolve
      })
    }
  }

  return {
    name: 'bash',
    description: 'Execute bash commands. IMPORTANT: NEVER restart the toebeans server via tmux or systemctl - only kanoko (the agent) should call restart_server.',

    input: inputGenerator(),

    tools: [
      {
        name: 'bash',
        description: 'Execute a bash command.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute' },
            workingDir: { type: 'string', description: 'Optional working directory' },
            timeout: {
              type: 'number',
              description: `Timeout in seconds (default: ${DEFAULT_TIMEOUT_S}, max: ${MAX_TIMEOUT_S})`,
              minimum: 1,
              maximum: MAX_TIMEOUT_S,
            },
          },
          required: ['command'],
        },
        async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
          const { command, workingDir, timeout = DEFAULT_TIMEOUT_S } = input as {
            command: string
            workingDir?: string
            timeout?: number
          }
          const cwd = workingDir ? resolve(context.workingDir, workingDir) : context.workingDir
          const timeoutMs = Math.min(Math.max(timeout, 1), MAX_TIMEOUT_S) * 1000

          const proc = Bun.spawn(['bash', '-c', command], {
            cwd,
            stdout: 'pipe',
            stderr: 'pipe',
          })

          const result = await Promise.race([
            proc.exited.then(async (code) => {
              const stdout = await new Response(proc.stdout).text()
              const stderr = await new Response(proc.stderr).text()
              return { code, stdout, stderr, timedOut: false }
            }),
            new Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }>(resolve =>
              setTimeout(() => {
                proc.kill()
                resolve({ code: -1, stdout: '', stderr: '', timedOut: true })
              }, timeoutMs)
            ),
          ])

          if (result.timedOut) {
            return {
              content: `Command timed out after ${timeout} seconds`,
              is_error: true,
            }
          }

          const output = [result.stdout, result.stderr].filter(Boolean).join('\n')

          if (result.code !== 0) {
            return {
              content: output || `Command failed with exit code ${result.code}`,
              is_error: true,
            }
          }

          return { content: output || '(no output)' }
        },
      },

      {
        name: 'bash_spawn',
        description: 'Start a long-running bash command in the background. You will be notified when it completes.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute' },
            workingDir: { type: 'string', description: 'Optional working directory' },
            timeout: {
              type: 'number',
              description: `Timeout in seconds (default: ${SPAWN_DEFAULT_TIMEOUT_S}, max: ${SPAWN_MAX_TIMEOUT_S})`,
              minimum: 1,
              maximum: SPAWN_MAX_TIMEOUT_S,
            },
          },
          required: ['command'],
        },
        async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
          const { command, workingDir, timeout = SPAWN_DEFAULT_TIMEOUT_S } = input as {
            command: string
            workingDir?: string
            timeout?: number
          }

          await ensureBashLogsDir()

          const cwd = workingDir ? resolve(context.workingDir, workingDir) : context.workingDir
          const timeoutMs = Math.min(Math.max(timeout, 1), SPAWN_MAX_TIMEOUT_S) * 1000
          const logFilename = generateLogFilename()
          const logPath = join(BASH_LOGS_DIR, logFilename)

          try {
            // spawn with stdout/stderr piped
            const proc = Bun.spawn(
              ['bash', '-c', command],
              {
                cwd,
                env: process.env,
                stdout: 'pipe',
                stderr: 'pipe',
              }
            )

            const processInfo: SpawnedProcess = {
              proc,
              pid: proc.pid,
              command,
              logPath,
              startedAt: new Date().toISOString(),
            }

            spawnedProcesses.set(proc.pid, processInfo)

            // stream stdout/stderr to log file
            const logFile = Bun.file(logPath).writer()

            // pipe stdout
            const stdoutReader = proc.stdout.getReader()
            ;(async () => {
              try {
                while (true) {
                  const { done, value } = await stdoutReader.read()
                  if (done) break
                  logFile.write(value)
                }
              } catch (err) {
                console.error(`[bash_spawn] error reading stdout for pid ${proc.pid}:`, err)
              }
            })()

            // pipe stderr
            const stderrReader = proc.stderr.getReader()
            ;(async () => {
              try {
                while (true) {
                  const { done, value } = await stderrReader.read()
                  if (done) break
                  logFile.write(value)
                }
              } catch (err) {
                console.error(`[bash_spawn] error reading stderr for pid ${proc.pid}:`, err)
              }
            })()

            // set up completion notification
            proc.exited.then(async (code) => {
              try {
                // flush and close log file
                await logFile.end()

                spawnedProcesses.delete(proc.pid)

                const status = code === 0 ? 'completed successfully' : `failed with exit code ${code}`
                const commandPreview = command.length > 80 ? command.slice(0, 80) + '...' : command
                const lastLines = await readLastLines(logPath, 10)

                queueNotification(
                  `[bash process ${status}]\nPID: ${proc.pid}\nCommand: ${commandPreview}\nExit code: ${code ?? 1}\nLog: ${logPath}\n\nLast 10 lines:\n${lastLines}\n\nUse bash_check to see more output.`
                )
              } catch (err) {
                console.error(`[bash_spawn] error in exit handler for pid ${proc.pid}:`, err)
              }
            }).catch((err) => {
              console.error(`[bash_spawn] proc.exited promise rejected for pid ${proc.pid}:`, err)
            })

            // set up timeout killer
            setTimeout(() => {
              try {
                process.kill(proc.pid, 0) // check if still alive
                proc.kill()
                queueNotification(
                  `[bash process timed out]\nPID: ${proc.pid}\nCommand: ${command.slice(0, 80)}${command.length > 80 ? '...' : ''}\nKilled after ${timeout}s`
                )
              } catch {
                // already dead
              }
            }, timeoutMs)

            return {
              content: JSON.stringify({
                pid: proc.pid,
                logPath,
                status: 'started',
              }, null, 2)
            }
          } catch (err: unknown) {
            const error = err as { message?: string }
            return { content: `Failed to spawn command: ${error.message}`, is_error: true }
          }
        },
      },

      {
        name: 'bash_check',
        description: 'Check on a spawned bash process and read its output.',
        inputSchema: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: 'Process ID returned from bash_spawn' },
            tail: { type: 'number', description: 'Number of lines to show from end of log (default: 20)' },
          },
          required: ['pid'],
        },
        async execute(input: unknown): Promise<ToolResult> {
          const { pid, tail = 20 } = input as { pid: number; tail?: number }

          const processInfo = spawnedProcesses.get(pid)

          // check if process is running
          let isRunning = false
          try {
            process.kill(pid, 0)
            isRunning = true
          } catch {
            isRunning = false
          }

          const status = isRunning ? 'running' : 'completed'

          // try to get log path
          let logPath: string
          let command: string
          if (processInfo) {
            logPath = processInfo.logPath
            command = processInfo.command
          } else {
            // process not tracked - can't get log
            return {
              content: JSON.stringify({
                status: 'unknown',
                message: 'Process not found in tracked processes. It may have completed before server started or was not spawned via bash_spawn.',
              }, null, 2),
              is_error: true,
            }
          }

          const lastLines = await readLastLines(logPath, tail)

          return {
            content: JSON.stringify({
              pid,
              command,
              status,
              logPath,
              lastLines,
            }, null, 2)
          }
        },
      },

      {
        name: 'bash_kill',
        description: 'Kill a spawned bash process.',
        inputSchema: {
          type: 'object',
          properties: {
            pid: { type: 'number', description: 'Process ID to kill' },
          },
          required: ['pid'],
        },
        async execute(input: unknown): Promise<ToolResult> {
          const { pid } = input as { pid: number }

          try {
            // check if process exists first
            process.kill(pid, 0)
            // send SIGTERM
            process.kill(pid, 15)

            // clean up from tracking
            spawnedProcesses.delete(pid)

            return {
              content: JSON.stringify({
                pid,
                status: 'killed',
                signal: 'SIGTERM',
              }, null, 2)
            }
          } catch (err: unknown) {
            const error = err as { code?: string; message?: string }
            if (error.code === 'ESRCH') {
              return {
                content: JSON.stringify({
                  pid,
                  status: 'not_found',
                  message: 'Process not found or already terminated',
                }, null, 2)
              }
            }
            return {
              content: `Failed to kill process: ${error.message}`,
              is_error: true,
            }
          }
        },
      },
    ],
  }
}
