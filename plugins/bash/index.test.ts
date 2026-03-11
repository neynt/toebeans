import { describe, test, expect, beforeAll } from 'bun:test'
import type { Plugin } from '../../server/plugin.ts'
import type { ToolContext } from '../../server/types.ts'
import { tmpdir } from 'os'
import { join } from 'path'
import { writeFile, mkdtemp } from 'node:fs/promises'

let plugin: Plugin
let bashTool: Plugin['tools'][number]
let bashSpawnTool: Plugin['tools'][number]
let testDir: string

const toolContext: ToolContext = {
  sessionId: 'test-session',
  workingDir: tmpdir(),
}

/** extract trimmed text content from a tool result */
function trimResult(result: { content: string | unknown }): string {
  return (result.content as string).trim()
}

beforeAll(async () => {
  const create = (await import('./index.ts')).default
  plugin = create()
  await plugin.init?.({})
  bashTool = plugin.tools!.find(t => t.name === 'bash')!
  bashSpawnTool = plugin.tools!.find(t => t.name === 'bash_spawn')!
  testDir = await mkdtemp(join(tmpdir(), 'bash-test-'))
})

describe('bash tool descriptions', () => {
  test('tool description mentions command substitution', () => {
    expect(bashTool.description).toContain('$(')
  })

  test('tool description mentions bash -c', () => {
    expect(bashTool.description).toContain('bash -c')
  })

  test('command field schema mentions no escaping', () => {
    const props = (bashTool.inputSchema as { properties: Record<string, { description: string }> }).properties
    expect(props.command!.description).toContain('no escaping')
  })

  test('plugin description mentions command substitution', () => {
    expect(plugin.description).toContain('$(cmd)')
  })

  test('plugin description mentions verbatim', () => {
    expect(plugin.description).toContain('verbatim')
  })
})

describe('bash tool command validation', () => {
  test('rejects missing command field', async () => {
    const result = await bashTool.execute({}, toolContext)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Missing or invalid')
  })

  test('rejects non-string command field', async () => {
    const result = await bashTool.execute({ command: 42 }, toolContext)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Missing or invalid')
  })

  test('rejects empty string command', async () => {
    const result = await bashTool.execute({ command: '' }, toolContext)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Missing or invalid')
  })
})

describe('bash_spawn tool command validation', () => {
  test('rejects missing command field', async () => {
    const result = await bashSpawnTool.execute({}, toolContext)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('Missing or invalid')
  })
})

describe('bash tool shell features', () => {
  test('$(...) command substitution', async () => {
    const result = await bashTool.execute(
      { command: 'echo $(echo hello)' },
      toolContext,
    )
    expect(result.is_error).toBeUndefined()
    expect(trimResult(result)).toBe('hello')
  })

  test('nested $(...) command substitution', async () => {
    const result = await bashTool.execute(
      { command: 'echo $(echo $(echo deep))' },
      toolContext,
    )
    expect(result.is_error).toBeUndefined()
    expect(trimResult(result)).toBe('deep')
  })

  test('$(...) reading from files', async () => {
    const testFile = join(testDir, 'subst-test.txt')
    await writeFile(testFile, 'file-content')

    const result = await bashTool.execute(
      { command: `echo $(cat ${testFile})` },
      toolContext,
    )
    expect(trimResult(result)).toBe('file-content')
  })

  test('variable expansion', async () => {
    const result = await bashTool.execute(
      { command: 'X=hello; echo $X' },
      toolContext,
    )
    expect(trimResult(result)).toBe('hello')
  })

  test('pipes', async () => {
    const result = await bashTool.execute(
      { command: 'echo -e "b\\na\\nc" | sort' },
      toolContext,
    )
    expect(trimResult(result)).toBe('a\nb\nc')
  })

  test('process substitution', async () => {
    const result = await bashTool.execute(
      { command: 'diff <(echo a) <(echo a)' },
      toolContext,
    )
    expect(result.content).toBe('(no output)')
  })

  test('heredoc', async () => {
    const result = await bashTool.execute(
      { command: "cat <<'EOF'\nhello world\nEOF" },
      toolContext,
    )
    expect(trimResult(result)).toBe('hello world')
  })

  test('backtick substitution', async () => {
    const result = await bashTool.execute(
      { command: 'echo `echo backtick`' },
      toolContext,
    )
    expect(trimResult(result)).toBe('backtick')
  })

  test('command from JSON.parse preserves $(...)', async () => {
    // simulate the exact flow: JSON string → JSON.parse → tool execute
    const jsonInput = '{"command": "echo $(echo from-json)"}'
    const parsed = JSON.parse(jsonInput)
    const result = await bashTool.execute(parsed, toolContext)
    expect(trimResult(result)).toBe('from-json')
  })

  test('redirects', async () => {
    const outFile = join(testDir, 'redirect-test.txt')
    await bashTool.execute(
      { command: `echo redirected > ${outFile}` },
      toolContext,
    )
    const result = await bashTool.execute(
      { command: `cat ${outFile}` },
      toolContext,
    )
    expect(trimResult(result)).toBe('redirected')
  })
})
