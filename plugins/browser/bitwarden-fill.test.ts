import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import createBrowserPlugin from './index.ts'

/**
 * Integration tests for bitwarden_fill behavior:
 * 1. Password must persist in the DOM after fill (regression test)
 * 2. extractMarkdown must redact password field values in output
 *
 * These tests use a real browser via the plugin's spawn/interact/close tools.
 * They don't call bitwarden_fill directly (that needs `bw` CLI), but they
 * exercise the same fill + extractMarkdown pipeline to verify the contract.
 */

const plugin = createBrowserPlugin()
const interact = plugin.tools!.find(t => t.name === 'browser_interact')!
const spawn = plugin.tools!.find(t => t.name === 'browser_spawn')!
const close = plugin.tools!.find(t => t.name === 'browser_close')!

const ctx = {
  sessionId: 'test-session',
  getWorkspaceDir: () => '/tmp',
} as any

const LOGIN_PAGE = `data:text/html,${encodeURIComponent(`<!DOCTYPE html>
<html><body>
  <form>
    <input type="text" id="username" name="username" autocomplete="username">
    <input type="password" id="password" name="password" autocomplete="current-password">
    <input type="text" id="secret_key" name="api_secret">
    <input type="text" id="email" name="email" autocomplete="email">
    <button type="submit" id="login">Log in</button>
  </form>
</body></html>`)}`

let sessionId: string

describe('password field persistence and redaction', () => {
  beforeAll(async () => {
    await plugin.init!({})
    const result = await spawn.execute({ url: LOGIN_PAGE }, ctx)
    const parsed = JSON.parse(result.content as string)
    sessionId = parsed.session_id
  })

  afterAll(async () => {
    if (sessionId) await close.execute({ session_id: sessionId }, ctx)
  })

  test('filled password persists in DOM for subsequent actions', async () => {
    // Fill username and password (simulating what bitwarden_fill does internally)
    await interact.execute({
      session_id: sessionId,
      actions: [
        { type: 'type', selector: '#username', text: 'alice@example.com' },
        { type: 'type', selector: '#password', text: 'correct-horse-battery-staple' },
      ],
    }, ctx)

    // Now read the password field value back — it should still be there
    const result = await interact.execute({
      session_id: sessionId,
      actions: [
        { type: 'evaluate', js: 'document.getElementById("password").value.length > 0' },
      ],
    }, ctx)

    const parsed = JSON.parse(result.content as string)
    expect(parsed.eval_results).toContain('true')
  })

  test('extractMarkdown redacts type="password" field values', async () => {
    // Fill both username and password
    await interact.execute({
      session_id: sessionId,
      actions: [
        { type: 'type', selector: '#username', text: 'alice@example.com' },
        { type: 'type', selector: '#password', text: 'correct-horse-battery-staple' },
      ],
    }, ctx)

    // Get the markdown content — password must be redacted
    const result = await interact.execute({
      session_id: sessionId,
      actions: [], // no actions, just get current page state
    }, ctx)

    const parsed = JSON.parse(result.content as string)
    const md = parsed.content as string

    // password must NOT appear in markdown
    expect(md).not.toContain('correct-horse-battery-staple')
    // but the redaction marker should be present
    expect(md).toContain('••••••')
    // username is not sensitive, should appear
    expect(md).toContain('alice@example.com')
  })

  test('extractMarkdown redacts fields with sensitive names even if type="text"', async () => {
    // Fill the api_secret field (type="text" but name matches sensitive pattern)
    await interact.execute({
      session_id: sessionId,
      actions: [
        { type: 'type', selector: '#secret_key', text: 'sk-super-secret-key-12345' },
      ],
    }, ctx)

    const result = await interact.execute({
      session_id: sessionId,
      actions: [],
    }, ctx)

    const parsed = JSON.parse(result.content as string)
    const md = parsed.content as string

    expect(md).not.toContain('sk-super-secret-key-12345')
    expect(md).toContain('••••••')
  })

  test('non-sensitive field values appear in markdown', async () => {
    await interact.execute({
      session_id: sessionId,
      actions: [
        { type: 'type', selector: '#email', text: 'bob@example.com' },
      ],
    }, ctx)

    const result = await interact.execute({
      session_id: sessionId,
      actions: [],
    }, ctx)

    const parsed = JSON.parse(result.content as string)
    const md = parsed.content as string

    expect(md).toContain('bob@example.com')
  })
})
