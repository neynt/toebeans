import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdir, rm } from 'node:fs/promises'
import createBrowserPlugin from './index.ts'

const plugin = createBrowserPlugin()
let sessionId: string
const tmpDir = join(tmpdir(), `toebeans-upload-test-${Date.now()}`)

// find the browser_interact tool from the plugin
const interact = plugin.tools!.find(t => t.name === 'browser_interact')!
const spawn = plugin.tools!.find(t => t.name === 'browser_spawn')!
const close = plugin.tools!.find(t => t.name === 'browser_close')!

const ctx = {
  sessionId: 'test-session',
  getWorkspaceDir: () => tmpDir,
} as any

describe('upload_file schema', () => {
  test('action anyOf includes upload_file variant', () => {
    const schema = interact.inputSchema as any
    const variants = schema.properties.actions.items.anyOf
    const uploadVariant = variants.find((v: any) => v.properties.type.const === 'upload_file')
    expect(uploadVariant).toBeDefined()
  })

  test('upload_file variant has file_paths property', () => {
    const schema = interact.inputSchema as any
    const variants = schema.properties.actions.items.anyOf
    const uploadVariant = variants.find((v: any) => v.properties.type.const === 'upload_file')
    expect(uploadVariant.properties.file_paths).toBeDefined()
    expect(uploadVariant.properties.file_paths.type).toBe('array')
    expect(uploadVariant.properties.file_paths.items.type).toBe('string')
  })
})

describe('upload_file integration', () => {
  beforeAll(async () => {
    await mkdir(tmpDir, { recursive: true })
    await plugin.init!({})
    const result = await spawn.execute({ url: `data:text/html,<input type="file" id="f" multiple>` }, ctx)
    const parsed = JSON.parse(result.content as string)
    sessionId = parsed.session_id
  })

  afterAll(async () => {
    if (sessionId) await close.execute({ session_id: sessionId }, ctx)
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('rejects missing selector', async () => {
    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'upload_file', file_paths: ['/tmp/test.txt'] }],
    }, ctx)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('upload_file requires selector')
  })

  test('rejects missing file_paths', async () => {
    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'upload_file', selector: '#f' }],
    }, ctx)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('upload_file requires file_paths')
  })

  test('rejects non-existent file', async () => {
    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'upload_file', selector: '#f', file_paths: ['/tmp/definitely-does-not-exist-12345.txt'] }],
    }, ctx)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('file not found')
  })

  test('uploads a real file', async () => {
    const testFile = join(tmpDir, 'hello.txt')
    await Bun.write(testFile, 'hello world')

    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'upload_file', selector: '#f', file_paths: [testFile] }],
    }, ctx)
    expect(result.is_error).toBeUndefined()
    const parsed = JSON.parse(result.content as string)
    expect(parsed.eval_results).toHaveLength(1)
    const uploadResult = JSON.parse(parsed.eval_results[0])
    expect(uploadResult.action).toBe('upload_file')
    expect(uploadResult.count).toBe(1)
    expect(uploadResult.files).toContain(testFile)
  })

  test('clears input with empty array', async () => {
    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'upload_file', selector: '#f', file_paths: [] }],
    }, ctx)
    expect(result.is_error).toBeUndefined()
    const parsed = JSON.parse(result.content as string)
    expect(parsed.eval_results).toHaveLength(1)
    const uploadResult = JSON.parse(parsed.eval_results[0])
    expect(uploadResult.count).toBe(0)
  })

  test('uploads multiple files', async () => {
    const file1 = join(tmpDir, 'a.txt')
    const file2 = join(tmpDir, 'b.txt')
    await Bun.write(file1, 'file a')
    await Bun.write(file2, 'file b')

    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'upload_file', selector: '#f', file_paths: [file1, file2] }],
    }, ctx)
    expect(result.is_error).toBeUndefined()
    const parsed = JSON.parse(result.content as string)
    const uploadResult = JSON.parse(parsed.eval_results[0])
    expect(uploadResult.count).toBe(2)
  })
})
