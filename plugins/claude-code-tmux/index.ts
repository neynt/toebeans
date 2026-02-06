import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult } from '../../server/types.ts'
import { $ } from 'bun'

const TMUX_SESSION = 'toebeans-claude-code'

async function ensureSession(): Promise<boolean> {
  try {
    await $`tmux has-session -t ${TMUX_SESSION}`.quiet()
    return true
  } catch {
    // session doesn't exist, create it
    try {
      await $`tmux new-session -d -s ${TMUX_SESSION}`.quiet()
      return true
    } catch (err) {
      return false
    }
  }
}

function createTools(): Tool[] {
  return [
    {
      name: 'cc_list',
      description: 'List all claude code windows in the toebeans-claude-code tmux session.',
      inputSchema: {
        type: 'object',
        properties: {},
      },
      async execute(): Promise<ToolResult> {
        if (!(await ensureSession())) {
          return { content: 'Failed to access tmux session', is_error: true }
        }

        try {
          const result = await $`tmux list-windows -t ${TMUX_SESSION} -F "#{window_index}: #{window_name} (#{pane_current_command})"`.quiet()
          const output = result.stdout.toString().trim()
          return { content: output || '(no windows)' }
        } catch (err: unknown) {
          const error = err as { stderr?: Buffer; message?: string }
          return { content: error.stderr?.toString() || error.message || 'Failed to list windows', is_error: true }
        }
      },
    },

    {
      name: 'cc_read',
      description: 'Capture the current visible content of a claude code pane. Use to check status.',
      inputSchema: {
        type: 'object',
        properties: {
          window: { type: 'number', description: 'Window index (default: 0)' },
          lines: { type: 'number', description: 'Number of lines to capture (default: 100)' },
        },
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { window = 0, lines = 100 } = input as { window?: number; lines?: number }

        if (!(await ensureSession())) {
          return { content: 'Failed to access tmux session', is_error: true }
        }

        try {
          const target = `${TMUX_SESSION}:${window}`
          const result = await $`tmux capture-pane -t ${target} -p -S -${lines}`.quiet()
          const output = result.stdout.toString()
          return { content: output || '(empty pane)' }
        } catch (err: unknown) {
          const error = err as { stderr?: Buffer; message?: string }
          return { content: error.stderr?.toString() || error.message || 'Failed to capture pane', is_error: true }
        }
      },
    },

    {
      name: 'cc_send',
      description: 'Send text/keys to a claude code pane. Use for typing commands or input.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Text to send' },
          window: { type: 'number', description: 'Window index (default: 0)' },
          enter: { type: 'boolean', description: 'Press Enter after text (default: true)' },
        },
        required: ['text'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { text, window = 0, enter = true } = input as { text: string; window?: number; enter?: boolean }

        if (!(await ensureSession())) {
          return { content: 'Failed to access tmux session', is_error: true }
        }

        try {
          const target = `${TMUX_SESSION}:${window}`
          if (enter) {
            await $`tmux send-keys -t ${target} ${text} Enter`.quiet()
          } else {
            await $`tmux send-keys -t ${target} ${text}`.quiet()
          }
          return { content: `Sent to window ${window}${enter ? ' (with Enter)' : ''}` }
        } catch (err: unknown) {
          const error = err as { stderr?: Buffer; message?: string }
          return { content: error.stderr?.toString() || error.message || 'Failed to send keys', is_error: true }
        }
      },
    },

    {
      name: 'cc_new',
      description: 'Create a new window in the claude code tmux session, optionally starting claude.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Window name' },
          dir: { type: 'string', description: 'Working directory' },
          start_claude: { type: 'boolean', description: 'Run "claude" command immediately (default: true)' },
        },
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { name, dir, start_claude = true } = input as { name?: string; dir?: string; start_claude?: boolean }

        if (!(await ensureSession())) {
          return { content: 'Failed to access tmux session', is_error: true }
        }

        try {
          const args = ['tmux', 'new-window', '-t', TMUX_SESSION]
          if (name) args.push('-n', name)
          if (dir) args.push('-c', dir)

          await $`${args}`.quiet()

          // get the new window index
          const result = await $`tmux display-message -t ${TMUX_SESSION} -p "#{window_index}"`.quiet()
          const windowIndex = result.stdout.toString().trim()

          if (start_claude) {
            await $`tmux send-keys -t ${TMUX_SESSION}:${windowIndex} "claude" Enter`.quiet()
          }

          return { content: `Created window ${windowIndex}${name ? ` (${name})` : ''}${start_claude ? ', started claude' : ''}` }
        } catch (err: unknown) {
          const error = err as { stderr?: Buffer; message?: string }
          return { content: error.stderr?.toString() || error.message || 'Failed to create window', is_error: true }
        }
      },
    },

    {
      name: 'cc_kill',
      description: 'Kill a window in the claude code tmux session.',
      inputSchema: {
        type: 'object',
        properties: {
          window: { type: 'number', description: 'Window index to kill' },
        },
        required: ['window'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const { window } = input as { window: number }

        try {
          await $`tmux kill-window -t ${TMUX_SESSION}:${window}`.quiet()
          return { content: `Killed window ${window}` }
        } catch (err: unknown) {
          const error = err as { stderr?: Buffer; message?: string }
          return { content: error.stderr?.toString() || error.message || 'Failed to kill window', is_error: true }
        }
      },
    },
  ]
}

export default function createClaudeCodeTmuxPlugin(): Plugin {
  return {
    name: 'claude-code-tmux',
    description: `Control Claude Code instances via tmux (session: ${TMUX_SESSION}):
- cc_list: List all windows
- cc_read: Capture pane content (check status)
- cc_send: Send text/keys to a pane
- cc_new: Create new window, optionally start claude
- cc_kill: Kill a window`,

    tools: createTools(),
  }
}
