import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { tmpdir } from 'os'
import { join } from 'path'
import { mkdir, rm } from 'node:fs/promises'
import createBrowserPlugin from './index.ts'

const plugin = createBrowserPlugin()
let sessionId: string
const tmpDir = join(tmpdir(), `toebeans-download-test-${Date.now()}`)

const interact = plugin.tools!.find(t => t.name === 'browser_interact')!
const spawn = plugin.tools!.find(t => t.name === 'browser_spawn')!
const close = plugin.tools!.find(t => t.name === 'browser_close')!

const ctx = {
  sessionId: 'test-session',
  getWorkspaceDir: () => tmpDir,
} as any

describe('download validation errors', () => {
  beforeAll(async () => {
    await mkdir(tmpDir, { recursive: true })
    await plugin.init!({})
    const result = await spawn.execute({ url: 'data:text/html,<a id="dl" href="data:text/plain,hello" download="test.txt">download</a>' }, ctx)
    const parsed = JSON.parse(result.content as string)
    sessionId = parsed.session_id
  })

  afterAll(async () => {
    if (sessionId) await close.execute({ session_id: sessionId }, ctx)
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('rejects missing download_path', async () => {
    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'download', selector: '#dl' }],
    }, ctx)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('download requires download_path')
  })

  test('rejects missing selector and url', async () => {
    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'download', download_path: join(tmpDir, 'out.txt') }],
    }, ctx)
    expect(result.is_error).toBe(true)
    expect(result.content).toContain('download requires selector or url')
  })

  test('download timeout returns tool error instead of crashing', async () => {
    // navigate to a page with no download link, then try to download via a non-download selector
    await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'goto', url: 'data:text/html,<button id="noop">noop</button>' }],
    }, ctx)

    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'download', selector: '#noop', download_path: join(tmpDir, 'never.txt') }],
    }, ctx)
    // should be a graceful error, not a process crash
    expect(result.is_error).toBe(true)
    expect(typeof result.content).toBe('string')
  }, 45_000) // allow enough time for the download + hard timeout

  test('successful download via selector', async () => {
    await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'goto', url: 'data:text/html,<a id="dl" href="data:text/plain,hello" download="test.txt">download</a>' }],
    }, ctx)

    const dlPath = join(tmpDir, 'downloaded.txt')
    const result = await interact.execute({
      session_id: sessionId,
      actions: [{ type: 'download', selector: '#dl', download_path: dlPath }],
    }, ctx)
    expect(result.is_error).toBeUndefined()
    const parsed = JSON.parse(result.content as string)
    expect(parsed.downloads).toHaveLength(1)
    expect(parsed.downloads[0].saved_to).toBe(dlPath)

    const content = await Bun.file(dlPath).text()
    expect(content).toBe('hello')
  })
})
