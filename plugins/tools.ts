import type { Plugin } from '../server/plugin.ts'
import type { Tool, ToolResult, ToolContext } from '../server/types.ts'
import { $ } from 'bun'
import { resolve, dirname } from 'path'

interface ToolsConfig {
  allowBash?: boolean
}

function createTools(config: ToolsConfig): Tool[] {
  const tools: Tool[] = []

  if (config.allowBash !== false) {
    tools.push({
      name: 'bash',
      description: 'Execute a bash command. Use for running programs, git, etc.',
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
    })
  }

  tools.push({
    name: 'read',
    description: 'Read the contents of a file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to read' },
      },
      required: ['path'],
    },
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const { path } = input as { path: string }
      const fullPath = resolve(context.workingDir, path)

      try {
        const content = await Bun.file(fullPath).text()
        return { content }
      } catch (err) {
        return { content: `Failed to read file: ${err}`, is_error: true }
      }
    },
  })

  tools.push({
    name: 'write',
    description: 'Write content to a file. Creates parent directories if needed.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file to write' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['path', 'content'],
    },
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const { path, content } = input as { path: string; content: string }
      const fullPath = resolve(context.workingDir, path)

      try {
        // ensure parent directory exists
        const dir = dirname(fullPath)
        await $`mkdir -p ${dir}`.quiet()

        await Bun.write(fullPath, content)
        return { content: `Wrote ${content.length} bytes to ${path}` }
      } catch (err) {
        return { content: `Failed to write file: ${err}`, is_error: true }
      }
    },
  })

  tools.push({
    name: 'glob',
    description: 'Find files matching a glob pattern.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts")' },
        cwd: { type: 'string', description: 'Directory to search in' },
      },
      required: ['pattern'],
    },
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const { pattern, cwd } = input as { pattern: string; cwd?: string }
      const searchDir = cwd ? resolve(context.workingDir, cwd) : context.workingDir

      try {
        const glob = new Bun.Glob(pattern)
        const files: string[] = []
        for await (const file of glob.scan(searchDir)) {
          files.push(file)
          if (files.length >= 100) {
            files.push('... (truncated)')
            break
          }
        }
        return { content: files.join('\n') || '(no matches)' }
      } catch (err) {
        return { content: `Glob failed: ${err}`, is_error: true }
      }
    },
  })

  tools.push({
    name: 'grep',
    description: 'Search for a pattern in files.',
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Search pattern (regex)' },
        path: { type: 'string', description: 'File or directory to search' },
        glob: { type: 'string', description: 'Glob pattern to filter files' },
      },
      required: ['pattern'],
    },
    async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
      const { pattern, path, glob: globPattern } = input as { pattern: string; path?: string; glob?: string }
      const searchPath = path ? resolve(context.workingDir, path) : context.workingDir

      try {
        const args = ['rg', '--line-number', '--max-count', '50']
        if (globPattern) {
          args.push('--glob', globPattern)
        }
        args.push(pattern, searchPath)

        const result = await $`${args}`.quiet()
        return { content: result.stdout.toString() || '(no matches)' }
      } catch (err: unknown) {
        const error = err as { exitCode?: number; stdout?: Buffer }
        // rg returns exit code 1 for no matches
        if (error.exitCode === 1) {
          return { content: '(no matches)' }
        }
        return { content: `Grep failed: ${error.stdout?.toString() || err}`, is_error: true }
      }
    },
  })

  return tools
}

export default function createToolsPlugin(): Plugin {
  let tools: Tool[] = []

  return {
    name: 'tools',
    description: `File and shell tools:
- bash: Execute shell commands
- read: Read file contents
- write: Write to files (creates directories)
- glob: Find files by pattern
- grep: Search file contents with regex`,

    get tools() {
      return tools
    },

    init(config: unknown) {
      tools = createTools((config ?? {}) as ToolsConfig)
    },
  }
}
