import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult, ToolContext } from '../server/types.ts'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { homedir } from 'os'
import { join } from 'path'

const DATA_DIR = process.env.XDG_DATA_HOME ?? join(homedir(), '.local', 'share')
const LOG_DIR = join(DATA_DIR, 'toebeans', 'claude-code')

// track running processes by session id
const runningProcesses = new Map<string, { proc: ReturnType<typeof Bun.spawn>; pid: number }>()

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

function createTools(): Tool[] {
  return [
    {
      name: 'spawn_claude_code',
      description: 'Spawn a new Claude Code session with a one-shot task. Returns session ID and log file path.',
      inputSchema: {
        type: 'object',
        properties: {
          task: { type: 'string', description: 'The task/prompt to send to Claude Code' },
          workingDir: { type: 'string', description: 'Working directory for the claude code process (optional)' },
        },
        required: ['task'],
      },
      async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
        const { task, workingDir } = input as { task: string; workingDir?: string }

        await ensureLogDir()
        const sessionId = generateSessionId()
        const logPath = getLogPath(sessionId)
        const cwd = workingDir ?? context.workingDir

        try {
          const logFile = Bun.file(logPath)
          const writer = logFile.writer()

          // write header
          const header = `# Claude Code Session: ${sessionId}\n# Started: ${new Date().toISOString()}\n# Task: ${task}\n# Working Dir: ${cwd}\n\n`
          writer.write(header)

          const proc = Bun.spawn(
            ['claude', '-p', '--dangerously-skip-permissions', '--output-format', 'json', task],
            {
              cwd,
              stdout: 'pipe',
              stderr: 'pipe',
            }
          )

          runningProcesses.set(sessionId, { proc, pid: proc.pid })

          // stream stdout to log file
          ;(async () => {
            const reader = proc.stdout.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                writer.write(value)
              }
            } finally {
              reader.releaseLock()
            }
          })()

          // stream stderr to log file
          ;(async () => {
            const reader = proc.stderr.getReader()
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                writer.write(new TextEncoder().encode(`[stderr] `))
                writer.write(value)
              }
            } finally {
              reader.releaseLock()
            }
          })()

          // cleanup when process exits
          proc.exited.then(async (code) => {
            const footer = `\n# Exited with code: ${code}\n# Ended: ${new Date().toISOString()}\n`
            writer.write(footer)
            await writer.end()
            runningProcesses.delete(sessionId)
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
          const logFiles = files.filter(f => f.endsWith('.log'))

          // get stats and sort by mtime
          const sessions = await Promise.all(
            logFiles.map(async (file) => {
              const sessionId = file.replace('.log', '')
              const logPath = join(LOG_DIR, file)
              const fileStat = await stat(logPath)

              // check if process is still running
              const running = runningProcesses.get(sessionId)
              let status = 'completed'
              let pid: number | undefined

              if (running) {
                // check if process is actually still alive
                try {
                  process.kill(running.pid, 0) // signal 0 just checks if process exists
                  status = 'running'
                  pid = running.pid
                } catch {
                  status = 'completed'
                  runningProcesses.delete(sessionId)
                }
              }

              // read last few lines for status
              const content = await Bun.file(logPath).text()
              const lines = content.trim().split('\n')
              const lastLines = lines.slice(-3).join('\n')

              return {
                sessionId,
                status,
                pid,
                mtime: fileStat.mtime,
                size: fileStat.size,
                lastLines,
              }
            })
          )

          // sort by mtime descending
          sessions.sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

          const result = sessions.slice(0, limit).map(s => ({
            sessionId: s.sessionId,
            status: s.status,
            pid: s.pid,
            modified: s.mtime.toISOString(),
            sizeBytes: s.size,
            preview: s.lastLines.slice(0, 200) + (s.lastLines.length > 200 ? '...' : ''),
          }))

          return { content: JSON.stringify(result, null, 2) }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `Failed to list sessions: ${error.message}`, is_error: true }
        }
      },
    },

    {
      name: 'read_claude_code_output',
      description: 'Read output from a Claude Code session log.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string', description: 'The session ID to read' },
          tail: { type: 'number', description: 'Only return last N lines (optional, returns all if not specified)' },
        },
        required: ['sessionId'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { sessionId, tail } = input as { sessionId: string; tail?: number }

        const logPath = getLogPath(sessionId)
        const file = Bun.file(logPath)

        if (!(await file.exists())) {
          return { content: `Session not found: ${sessionId}`, is_error: true }
        }

        try {
          const content = await file.text()

          if (tail) {
            const lines = content.split('\n')
            const tailLines = lines.slice(-tail)
            return { content: tailLines.join('\n') }
          }

          return { content }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `Failed to read session: ${error.message}`, is_error: true }
        }
      },
    },
  ]
}

export default function createClaudeCodeDirectPlugin(): Plugin {
  return {
    name: 'claude-code-direct',
    description: `Spawn one-shot Claude Code tasks and monitor their output:
- spawn_claude_code: Start a new task, returns session ID
- list_claude_code_sessions: List recent sessions with status
- read_claude_code_output: Read output from a session log`,

    tools: createTools(),

    async init() {
      await ensureLogDir()
    },
  }
}
