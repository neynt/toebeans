import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult, ToolContext } from '../../server/types.ts'
import { $ } from 'bun'
import { resolve } from 'path'

export default function createBashPlugin(): Plugin {
  return {
    name: 'bash',
    description: 'Execute bash commands.',

    tools: [
      {
        name: 'bash',
        description: 'Execute a bash command.',
        inputSchema: {
          type: 'object',
          properties: {
            command: { type: 'string', description: 'The bash command to execute' },
            workingDir: { type: 'string', description: 'Optional working directory' },
          },
          required: ['command'],
        },
        async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
          const { command, workingDir } = input as { command: string; workingDir?: string }
          const cwd = workingDir ? resolve(context.workingDir, workingDir) : context.workingDir

          try {
            const result = await $`bash -c ${command}`.cwd(cwd).quiet()
            const output = result.stdout.toString() + result.stderr.toString()
            return { content: output || '(no output)' }
          } catch (err: unknown) {
            const error = err as { stdout?: Buffer; stderr?: Buffer; message?: string }
            const output = (error.stdout?.toString() ?? '') + (error.stderr?.toString() ?? '')
            return { content: output || error.message || 'Command failed', is_error: true }
          }
        },
      },
    ],
  }
}
