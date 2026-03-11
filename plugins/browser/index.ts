import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult, ToolContext } from '../../server/types.ts'
import { getDataDir, getWorkspaceDir } from '../../server/session.ts'
import { chromium } from 'patchright'
import type { Browser, BrowserContext, Page } from 'patchright'

import TurndownService from 'turndown'
import { join, dirname } from 'path'
import { expandTilde } from '../../server/paths.ts'
import { mkdir, readdir, rm } from 'node:fs/promises'
import { $ } from 'bun'

// --- config ---

interface BrowserConfig {
  locale?: string
  timezone?: string
  sessionTimeoutMs?: number
  persistentTimeoutMs?: number
  persistentMaxAgeDays?: number
  navigationTimeout?: number
  selectorTimeout?: number
  downloadTimeout?: number
  maxContentLength?: number
  remoteDebuggingPort?: number
  headless?: boolean
}

let config: BrowserConfig = {}

/**
 * Strip empty-string, zero, and empty-array values from action objects.
 * LLMs often fill every schema field with defaults (e.g. `"url": ""`, `"ms": 0`,
 * `"file_paths": []`) instead of omitting unused keys. Treat those as absent so the
 * execute logic's `!action.foo` checks work correctly.
 */
export function stripEmptyActionFields(action: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(action)) {
    if (v === '') continue
    if (v === 0) continue
    if (Array.isArray(v) && v.length === 0 && k !== 'file_paths') continue // file_paths: [] means "clear input"
    cleaned[k] = v
  }
  return cleaned
}

/**
 * Normalize hallucinated action type names to canonical ones.
 * LLMs (especially via OpenAI-compatible APIs that may not fully support anyOf
 * discriminated unions) sometimes invent close-but-wrong action names like
 * "fill_credentials" instead of "bitwarden_fill" or "click_by_text" instead of "click_text".
 */
const ACTION_ALIASES: Record<string, string> = {
  // bitwarden_fill aliases — LLMs frequently guess credential-centric names
  fill_credentials: 'bitwarden_fill',
  credential_fill: 'bitwarden_fill',
  credentials: 'bitwarden_fill',
  bitwarden: 'bitwarden_fill',
  fill_password: 'bitwarden_fill',
  autofill: 'bitwarden_fill',
  // click_text aliases
  click_by_text: 'click_text',
  text_click: 'click_text',
  // type aliases
  fill: 'type',
  input: 'type',
  // evaluate aliases
  eval: 'evaluate',
  run_js: 'evaluate',
  javascript: 'evaluate',
  // navigate aliases
  navigate: 'goto',
  open: 'goto',
  // wait_for aliases
  wait_for_selector: 'wait_for',
}

export function normalizeActionType(type: string): string {
  return ACTION_ALIASES[type] ?? type
}

const HARD_TIMEOUT_MS = 60_000
const NAV_TIMEOUT = () => config.navigationTimeout ?? 15_000
const SELECTOR_TIMEOUT = () => config.selectorTimeout ?? 2_000
const DOWNLOAD_TIMEOUT = () => config.downloadTimeout ?? 30_000
const SESSION_TIMEOUT = () => config.sessionTimeoutMs ?? 300_000
const PERSISTENT_TIMEOUT = () => config.persistentTimeoutMs ?? 86_400_000 // 24h
const PERSISTENT_MAX_AGE_DAYS = () => config.persistentMaxAgeDays ?? 7
const MAX_CONTENT = () => config.maxContentLength ?? 80_000

// --- persistent session storage ---

const SESSIONS_DIR = join(getDataDir(), 'browser-sessions')

function sessionDataDir(name: string): string {
  return join(SESSIONS_DIR, name)
}

function sessionMetaPath(name: string): string {
  return join(SESSIONS_DIR, name, '.toebeans-meta.json')
}

interface SessionMeta {
  name: string
  createdAt: number
  lastActivity: number
  lastUrl?: string
}

async function loadSessionMeta(name: string): Promise<SessionMeta | null> {
  try {
    const file = Bun.file(sessionMetaPath(name))
    if (await file.exists()) return await file.json()
  } catch { /* missing or corrupt */ }
  return null
}

async function saveSessionMeta(meta: SessionMeta): Promise<void> {
  await mkdir(sessionDataDir(meta.name), { recursive: true })
  await Bun.write(sessionMetaPath(meta.name), JSON.stringify(meta, null, 2))
}

async function listPersistedSessions(): Promise<SessionMeta[]> {
  try {
    const entries = await readdir(SESSIONS_DIR, { withFileTypes: true })
    const results: SessionMeta[] = []
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const meta = await loadSessionMeta(entry.name)
      if (meta) results.push(meta)
    }
    return results.sort((a, b) => b.lastActivity - a.lastActivity)
  } catch {
    return []
  }
}

async function cleanStaleSessions(): Promise<string[]> {
  const maxAge = PERSISTENT_MAX_AGE_DAYS() * 24 * 60 * 60 * 1000
  const cutoff = Date.now() - maxAge
  const cleaned: string[] = []
  try {
    const entries = await readdir(SESSIONS_DIR, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      // don't clean sessions that are currently active in-memory
      if (sessions.has(entry.name)) continue
      const meta = await loadSessionMeta(entry.name)
      if (meta && meta.lastActivity < cutoff) {
        await rm(sessionDataDir(entry.name), { recursive: true, force: true })
        cleaned.push(entry.name)
      }
    }
  } catch { /* dir doesn't exist yet */ }
  return cleaned
}

// --- cookie persistence (for ephemeral sessions) ---

const COOKIE_PATH = join(getDataDir(), 'secrets', 'browser-cookies.json')

async function loadCookies(): Promise<any[]> {
  try {
    const file = Bun.file(COOKIE_PATH)
    if (await file.exists()) return await file.json()
  } catch (err) {
    console.warn('[browser] failed to load cookies:', err)
  }
  return []
}

async function saveCookies(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies()
    await mkdir(dirname(COOKIE_PATH), { recursive: true })
    await Bun.write(COOKIE_PATH, JSON.stringify(cookies, null, 2))
  } catch (err) {
    console.warn('[browser] failed to save cookies:', err)
  }
}

// --- stealth ---

const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const WEBGL_SPOOF = `
  const sp = { 37445: 'Google Inc. (NVIDIA)', 37446: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 SUPER, OpenGL 4.5)' };
  for (const Ctx of [WebGLRenderingContext, typeof WebGL2RenderingContext !== 'undefined' ? WebGL2RenderingContext : null].filter(Boolean)) {
    const orig = Ctx.prototype.getParameter;
    Ctx.prototype.getParameter = function(p) { return sp[p] ?? orig.call(this, p); };
  }
`

// --- browser singleton (for ephemeral sessions) ---

let browser: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (!browser) {
    const args = ['--disable-blink-features=AutomationControlled']
    if (config.remoteDebuggingPort) {
      args.push(`--remote-debugging-port=${config.remoteDebuggingPort}`)
    }
    browser = await chromium.launch({
      channel: 'chrome',
      headless: config.headless ?? true,
      args,
    })
  }
  return browser
}

function launchArgs(): string[] {
  const args = ['--disable-blink-features=AutomationControlled']
  if (config.remoteDebuggingPort) {
    args.push(`--remote-debugging-port=${config.remoteDebuggingPort}`)
  }
  return args
}

async function makeContext(b: Browser): Promise<BrowserContext> {
  const ctx = await b.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: config.locale ?? 'en-US',
    timezoneId: config.timezone ?? 'America/New_York',
    userAgent: USER_AGENT,
    acceptDownloads: true,
  })
  await ctx.addInitScript(WEBGL_SPOOF)
  const cookies = await loadCookies()
  if (cookies.length > 0) await ctx.addCookies(cookies)
  return ctx
}

async function cleanStaleLocks(dataDir: string): Promise<void> {
  // Chromium leaves SingletonLock/SingletonSocket/SingletonCookie symlinks when killed
  // without graceful shutdown. Remove them so launchPersistentContext doesn't choke.
  for (const name of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    try { await rm(join(dataDir, name), { force: true }) } catch { /* fine */ }
  }
}

async function makePersistentContext(name: string): Promise<BrowserContext> {
  const dataDir = sessionDataDir(name)
  await mkdir(dataDir, { recursive: true })
  await cleanStaleLocks(dataDir)

  const ctx = await chromium.launchPersistentContext(dataDir, {
    channel: 'chrome',
    headless: config.headless ?? true,
    args: launchArgs(),
    viewport: { width: 1920, height: 1080 },
    locale: config.locale ?? 'en-US',
    timezoneId: config.timezone ?? 'America/New_York',
    userAgent: USER_AGENT,
    acceptDownloads: true,
  })
  await ctx.addInitScript(WEBGL_SPOOF)
  return ctx
}

// --- session management ---

interface Session {
  context: BrowserContext
  page: Page
  lastActivity: number
  timer: ReturnType<typeof setTimeout>
  debugPort: number | null
  persistent: boolean
  sessionName?: string
}

const sessions = new Map<string, Session>()
let counter = 0

function newId(): string {
  return `browser-${++counter}-${Date.now().toString(36)}`
}

function sessionTimeout(persistent: boolean): number {
  return persistent ? PERSISTENT_TIMEOUT() : SESSION_TIMEOUT()
}

function touch(id: string): void {
  const s = sessions.get(id)
  if (!s) return
  s.lastActivity = Date.now()
  clearTimeout(s.timer)
  s.timer = setTimeout(() => closeSession(id), sessionTimeout(s.persistent))
}

async function closeSession(id: string): Promise<void> {
  const s = sessions.get(id)
  if (!s) return
  clearTimeout(s.timer)
  try {
    // for persistent sessions, update meta with last url before closing
    if (s.persistent && s.sessionName) {
      const meta = await loadSessionMeta(s.sessionName)
      if (meta) {
        meta.lastActivity = Date.now()
        try { meta.lastUrl = s.page.url() } catch { /* page might be closed */ }
        await saveSessionMeta(meta)
      }
    } else {
      await saveCookies(s.context)
    }
    await safeCloseContext(s.context)
  } catch { /* already closed */ }
  sessions.delete(id)
}

function requireSession(id: string): Session {
  const s = sessions.get(id)
  if (!s) throw new Error(`session "${id}" not found (expired or never created)`)
  touch(id)
  return s
}

// --- helpers ---

function htmlToMarkdown(html: string): string {
  const td = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' })
  let content = td.turndown(html)
    .replace(/!\[([^\]]*)\]\(data:[^)]+\)/g, '')
    .split('\n')
    .map(l => l.trim())
    .filter(l => !/^\*(\s+\*)*\s*$/.test(l))
    .join('\n')
    .replace(/\n\n\n+/g, '\n\n')

  const max = MAX_CONTENT()
  if (content.length > max) {
    content = content.slice(0, max) + '\n\n[... truncated]'
  }
  return content
}

async function extractMarkdown(page: Page, selector?: string): Promise<string> {
  const html = await safeEvaluate(page, (sel: string | undefined) => {
    // mark hidden elements and snapshot live input values BEFORE cloning,
    // since getComputedStyle and .value only work on live DOM elements
    const HIDDEN_MARK = 'data-toebeans-hidden'
    const VALUE_MARK = 'data-toebeans-value'
    const marked: Element[] = []
    const valued: Element[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT)
    while (walker.nextNode()) {
      const el = walker.currentNode as Element
      const style = window.getComputedStyle(el)
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        el.setAttribute(HIDDEN_MARK, '1')
        marked.push(el)
      }
      // snapshot live .value for inputs/textareas (not preserved by cloneNode)
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
        const val = (el as HTMLInputElement).value
        if (val) {
          el.setAttribute(VALUE_MARK, val)
          valued.push(el)
        }
      }
    }

    // clone the body (or selected element) so we don't mutate the live DOM
    let root: Element
    if (sel) {
      const target = document.querySelector(sel)
      if (!target) throw new Error(`selector "${sel}" not found`)
      root = target.cloneNode(true) as Element
    } else {
      root = document.body.cloneNode(true) as Element
    }

    // clean up the marks on the LIVE dom immediately
    for (const el of marked) el.removeAttribute(HIDDEN_MARK)
    for (const el of valued) el.removeAttribute(VALUE_MARK)

    // now strip unwanted elements from the CLONE only
    root.querySelectorAll(
      `script, style, noscript, svg, canvas, [aria-hidden="true"], [${HIDDEN_MARK}]`
    ).forEach(el => el.remove())

    // --- annotate interactive elements for automation ---

    function selectorFor(el: Element): string {
      if (el.id) return `#${el.id}`
      const name = el.getAttribute('name')
      const tag = el.tagName.toLowerCase()
      if (name) return `${tag}[name="${name}"]`
      const type = el.getAttribute('type')
      if (type && tag === 'input') return `input[type="${type}"]`
      return tag
    }

    // annotate inputs, textareas
    root.querySelectorAll('input, textarea').forEach(el => {
      const tag = el.tagName.toLowerCase()
      const parts: string[] = [tag]
      if (el.id) parts.push(`id="${el.id}"`)
      const name = el.getAttribute('name')
      if (name) parts.push(`name="${name}"`)
      const type = el.getAttribute('type')
      if (type && tag === 'input') parts.push(`type="${type}"`)
      const placeholder = el.getAttribute('placeholder')
      if (placeholder) parts.push(`placeholder="${placeholder}"`)
      const ariaLabel = el.getAttribute('aria-label')
      if (ariaLabel) parts.push(`aria-label="${ariaLabel}"`)
      const val = el.getAttribute(VALUE_MARK) || el.getAttribute('value')
      if (val && type !== 'hidden') parts.push(`value="${val}"`)

      const marker = document.createElement('span')
      marker.textContent = `[${parts.join(' ')} → ${selectorFor(el)}]`
      el.replaceWith(marker)
    })

    // annotate selects — include their options with values
    root.querySelectorAll('select').forEach(el => {
      const parts: string[] = ['select']
      if (el.id) parts.push(`id="${el.id}"`)
      const name = el.getAttribute('name')
      if (name) parts.push(`name="${name}"`)
      const ariaLabel = el.getAttribute('aria-label')
      if (ariaLabel) parts.push(`aria-label="${ariaLabel}"`)

      const options = el.querySelectorAll('option')
      const optStrs: string[] = []
      options.forEach(opt => {
        const val = opt.getAttribute('value')
        const text = (opt.textContent || '').trim()
        const selected = opt.hasAttribute('selected') ? ' (selected)' : ''
        optStrs.push(val !== null ? `"${text}"=${val}${selected}` : `"${text}"${selected}`)
      })

      const marker = document.createElement('span')
      const optSummary = optStrs.length > 0 ? ` options: ${optStrs.join(', ')}` : ''
      marker.textContent = `[${parts.join(' ')}${optSummary} → ${selectorFor(el)}]`
      el.replaceWith(marker)
    })

    // annotate buttons
    root.querySelectorAll('button, [role="button"]').forEach(el => {
      const tag = el.tagName.toLowerCase()
      const hint = document.createElement('span')
      const parts: string[] = []
      if (el.id) parts.push(`id="${el.id}"`)
      const ariaLabel = el.getAttribute('aria-label')
      if (ariaLabel) parts.push(`aria-label="${ariaLabel}"`)
      const attrStr = parts.length > 0 ? ` ${parts.join(' ')}` : ''
      hint.textContent = ` [${tag}${attrStr} → ${selectorFor(el)}]`
      el.appendChild(hint)
    })

    // annotate links with useful attributes
    root.querySelectorAll('a[href]').forEach(el => {
      if (el.id || el.getAttribute('aria-label')) {
        const parts: string[] = []
        if (el.id) parts.push(`id="${el.id}"`)
        const ariaLabel = el.getAttribute('aria-label')
        if (ariaLabel) parts.push(`aria-label="${ariaLabel}"`)
        const hint = document.createElement('span')
        hint.textContent = ` [a ${parts.join(' ')} → ${selectorFor(el)}]`
        el.appendChild(hint)
      }
    })

    return root.innerHTML || ''
  }, selector) as string

  return htmlToMarkdown(html)
}

async function screenshotDir(): Promise<string> {
  const dir = join(getWorkspaceDir(), 'images')
  await mkdir(dir, { recursive: true })
  return dir
}

async function takeScreenshot(page: Page): Promise<string> {
  const dir = await screenshotDir()
  const filename = `browser-${Date.now()}.png`
  const filepath = join(dir, filename)
  await page.screenshot({ path: filepath, fullPage: false })
  return filepath
}

/** race a promise against a hard timeout */
function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`hard timeout: ${label} exceeded ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS)
    ),
  ])
}

const CLOSE_TIMEOUT_MS = 10_000

/** close a browser context with a 10s timeout; force-kills the browser process on hang */
async function safeCloseContext(context: BrowserContext): Promise<void> {
  try {
    await Promise.race([
      context.close(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('context.close() hung')), CLOSE_TIMEOUT_MS)
      ),
    ])
  } catch {
    // force-kill the underlying browser process
    try {
      const browser = context.browser()
      if (browser) {
        const proc = (browser as any).process?.()
        if (proc) {
          proc.kill('SIGKILL')
          console.warn('[browser] force-killed hung browser process')
        }
      }
    } catch { /* best effort */ }
  }
}

/** evaluate with a 10s timeout; force-kills the browser on hang */
async function safeEvaluate(page: Page, fn: string | ((...args: any[]) => any), arg?: any): Promise<any> {
  try {
    return await Promise.race([
      arg !== undefined ? page.evaluate(fn as any, arg) : page.evaluate(fn as any),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('page.evaluate() hung')), CLOSE_TIMEOUT_MS)
      ),
    ])
  } catch (err) {
    // try to force-kill the browser process if evaluate is stuck
    try {
      const browser = page.context().browser()
      if (browser) {
        const proc = (browser as any).process?.()
        if (proc) {
          proc.kill('SIGKILL')
          console.warn('[browser] force-killed browser after evaluate hang')
        }
      }
    } catch { /* best effort */ }
    throw err
  }
}

// --- plugin ---

export default function create(): Plugin {
  return {
    name: 'browser',
    description: [
      'Stateful browser automation via CDP. Tools: browser_spawn, browser_screenshot, browser_view, browser_interact, browser_close, browser_sessions.',
      config.remoteDebuggingPort
        ? `User can inspect live at chrome://inspect (CDP port ${config.remoteDebuggingPort}).`
        : '',
      'Ephemeral sessions auto-expire after inactivity. Persistent sessions (session_name param) survive restarts and preserve all cookies/localStorage/state to disk.',
    ].filter(Boolean).join(' '),

    async init(cfg: unknown) {
      config = (cfg as BrowserConfig) ?? {}
      // clean stale persistent sessions on startup
      const cleaned = await cleanStaleSessions()
      if (cleaned.length > 0) {
        console.log(`[browser] cleaned ${cleaned.length} stale session(s): ${cleaned.join(', ')}`)
      }
    },

    tools: [
      // --- browser_spawn ---
      {
        name: 'browser_spawn',
        description: 'Spawn a browser session. By default ephemeral (expires after inactivity). Pass session_name to create/resume a persistent session whose cookies, localStorage, and all browsing state survive server restarts. Resuming an existing session_name reopens it with all prior state intact.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'Optional URL to navigate to immediately' },
            session_name: { type: 'string', description: 'Name for a persistent session. If this session_name was used before, all prior browsing state (cookies, localStorage, etc.) is restored. Use a short descriptive name like "gmail" or "github".' },
          },
        },
        async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
          const { url, session_name } = input as { url?: string; session_name?: string }
          const persistent = !!session_name

          // if persistent session is already open in-memory, just return it
          if (session_name && sessions.has(session_name)) {
            const existing = sessions.get(session_name)!
            touch(session_name)
            const result: Record<string, unknown> = {
              session_id: session_name,
              url: existing.page.url(),
              title: await existing.page.title(),
              resumed: true,
              persistent: true,
            }
            return { content: JSON.stringify(result, null, 2) }
          }

          const id = session_name ?? newId()
          let context: BrowserContext
          let isResume = false

          let existingMeta: SessionMeta | null = null
          if (persistent) {
            // check if this session existed on disk before
            existingMeta = await loadSessionMeta(session_name!)
            isResume = !!existingMeta
            context = await makePersistentContext(session_name!)
          } else {
            const b = await getBrowser()
            context = await makeContext(b)
          }

          const page = context.pages()[0] ?? await context.newPage()

          const session: Session = {
            context,
            page,
            lastActivity: Date.now(),
            timer: setTimeout(() => closeSession(id), sessionTimeout(persistent)),
            debugPort: config.remoteDebuggingPort ?? null,
            persistent,
            sessionName: session_name,
          }
          sessions.set(id, session)

          // save/update meta for persistent sessions
          if (persistent) {
            const meta: SessionMeta = {
              name: session_name!,
              createdAt: existingMeta?.createdAt ?? Date.now(),
              lastActivity: Date.now(),
            }
            await saveSessionMeta(meta)
          }

          const doWork = async (): Promise<ToolResult> => {
            if (url) {
              try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT() })
              } catch (err: unknown) {
                const e = err as Error
                if (!e.message.includes('imeout')) throw err
                console.warn(`[browser] nav timeout for ${url}, continuing`)
              }
            }

            const result: Record<string, unknown> = {
              session_id: id,
              url: page.url(),
              title: await page.title(),
              persistent,
            }
            if (isResume) result.resumed = true
            if (config.remoteDebuggingPort) {
              result.cdp_port = config.remoteDebuggingPort
              result.inspect_hint = `user can open chrome://inspect to see the live browser`
            }
            return { content: JSON.stringify(result, null, 2) }
          }

          try {
            return await withTimeout(doWork(), 'browser_spawn')
          } catch (err: unknown) {
            await closeSession(id)
            return { content: `error: ${(err as Error).message}`, is_error: true }
          }
        },
      },

      // --- browser_sessions ---
      {
        name: 'browser_sessions',
        description: 'List all persistent browser sessions saved to disk, plus any currently active in-memory sessions. Shows session names, last activity time, and whether currently active.',
        inputSchema: {
          type: 'object',
          properties: {},
        },
        async execute(_input: unknown, _ctx: ToolContext): Promise<ToolResult> {
          const persisted = await listPersistedSessions()
          const activeIds = [...sessions.keys()]

          const sessionList = persisted.map(meta => ({
            session_name: meta.name,
            created: new Date(meta.createdAt).toISOString(),
            last_activity: new Date(meta.lastActivity).toISOString(),
            last_url: meta.lastUrl,
            active: activeIds.includes(meta.name),
          }))

          // include any active ephemeral sessions too
          for (const [id, s] of sessions) {
            if (!s.persistent) {
              sessionList.push({
                session_name: id,
                created: new Date(s.lastActivity).toISOString(),
                last_activity: new Date(s.lastActivity).toISOString(),
                last_url: s.page.url(),
                active: true,
              })
            }
          }

          return {
            content: JSON.stringify({
              sessions: sessionList,
              persistent_dir: SESSIONS_DIR,
              max_age_days: PERSISTENT_MAX_AGE_DAYS(),
            }, null, 2),
          }
        },
      },

      // --- browser_screenshot ---
      {
        name: 'browser_screenshot',
        description: 'Take a screenshot of an existing browser session. Returns the file path to the saved PNG.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from browser_spawn' },
          },
          required: ['session_id'],
        },
        async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
          const { session_id } = input as { session_id: string }

          try {
            const session = requireSession(session_id)
            const path = await withTimeout(takeScreenshot(session.page), 'browser_screenshot')
            if (!session.persistent) await saveCookies(session.context)
            return { content: JSON.stringify({ session_id, path, url: session.page.url() }) }
          } catch (err: unknown) {
            return { content: `error: ${(err as Error).message}`, is_error: true }
          }
        },
      },

      // --- browser_view ---
      {
        name: 'browser_view',
        description: 'Get a text (markdown) representation of the current page in a browser session. Useful for reading page content without modifying state.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from browser_spawn' },
            selector: { type: 'string', description: 'Optional CSS selector to extract specific content' },
          },
          required: ['session_id'],
        },
        async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
          const { session_id, selector } = input as { session_id: string; selector?: string }

          try {
            const session = requireSession(session_id)

            const doWork = async (): Promise<ToolResult> => {
              const content = await extractMarkdown(session.page, selector)
              return {
                content: JSON.stringify({
                  session_id,
                  url: session.page.url(),
                  title: await session.page.title(),
                  content,
                }, null, 2),
              }
            }

            return await withTimeout(doWork(), 'browser_view')
          } catch (err: unknown) {
            return { content: `error: ${(err as Error).message}`, is_error: true }
          }
        },
      },

      // --- browser_interact ---
      {
        name: 'browser_interact',
        description: 'Perform actions on a browser session: navigate, click, click by text, type, press keys, wait, evaluate JS, take screenshots, scroll, select options, upload files, download files, and fill credentials from Bitwarden vault. Actions run sequentially. Returns the final page state as markdown. Selector-based actions (click, wait_for, select, upload_file) have a fast 2s timeout by default — if a selector isn\'t found quickly, the action fails immediately rather than hanging.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID from browser_spawn' },
            actions: {
              type: 'array',
              description: 'Sequential actions to perform. Each action only needs its relevant fields — omit unused ones.',
              items: {
                type: 'object',
                anyOf: [
                  {
                    properties: {
                      type: { const: 'goto', description: 'Navigate to a URL' },
                      url: { type: 'string', description: 'URL to navigate to' },
                    },
                    required: ['type', 'url'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'click', description: 'Click an element' },
                      selector: { type: 'string', description: 'CSS selector' },
                    },
                    required: ['type', 'selector'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'click_text', description: 'Click element containing text' },
                      text: { type: 'string', description: 'Text to find and click' },
                    },
                    required: ['type', 'text'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'type', description: 'Type text into an input' },
                      selector: { type: 'string', description: 'CSS selector for input' },
                      text: { type: 'string', description: 'Text to type' },
                    },
                    required: ['type', 'selector', 'text'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'press', description: 'Press a key' },
                      key: { type: 'string', description: 'Key name (e.g. "Enter", "Tab")' },
                    },
                    required: ['type', 'key'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'wait', description: 'Wait for a duration' },
                      ms: { type: 'number', description: 'Milliseconds to wait (default: 1000)' },
                    },
                    required: ['type'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'wait_for', description: 'Wait for a selector to appear' },
                      selector: { type: 'string', description: 'CSS selector to wait for' },
                      ms: { type: 'number', description: 'Custom timeout in ms (default: 2s)' },
                    },
                    required: ['type', 'selector'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'evaluate', description: 'Run JavaScript in the page' },
                      js: { type: 'string', description: 'JavaScript code to evaluate' },
                    },
                    required: ['type', 'js'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'screenshot', description: 'Take a screenshot' },
                    },
                    required: ['type'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'scroll', description: 'Scroll the page' },
                      direction: { type: 'string', enum: ['up', 'down'], description: 'Scroll direction (default: down)' },
                      amount: { type: 'number', description: 'Scroll amount in pixels (default: 500)' },
                    },
                    required: ['type'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'select', description: 'Select an option from a dropdown' },
                      selector: { type: 'string', description: 'CSS selector for select element' },
                      value: { type: 'string', description: 'Option value to select' },
                    },
                    required: ['type', 'selector', 'value'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'upload_file', description: 'Upload files to a file input' },
                      selector: { type: 'string', description: 'CSS selector for file input' },
                      file_paths: { type: 'array', items: { type: 'string' }, description: 'Local file paths (~ expanded). Empty array clears the input.' },
                    },
                    required: ['type', 'selector', 'file_paths'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'download', description: 'Download a file' },
                      download_path: { type: 'string', description: 'Local file path to save the download' },
                      selector: { type: 'string', description: 'CSS selector to click to trigger download' },
                      url: { type: 'string', description: 'URL to navigate to trigger download (alternative to selector)' },
                    },
                    required: ['type', 'download_path'],
                    additionalProperties: false,
                  },
                  {
                    properties: {
                      type: { const: 'bitwarden_fill', description: 'Fill credentials from Bitwarden vault' },
                      session_token: { type: 'string', description: 'Bitwarden session token from `bw unlock --raw`' },
                      search: { type: 'string', description: 'Search query for vault (e.g. domain name)' },
                      username_selector: { type: 'string', description: 'CSS selector for username/email input' },
                      password_selector: { type: 'string', description: 'CSS selector for password input' },
                      submit_selector: { type: 'string', description: 'Optional CSS selector for submit button' },
                    },
                    required: ['type', 'session_token', 'search', 'username_selector', 'password_selector'],
                    additionalProperties: false,
                  },
                ],
              },
            },
          },
          required: ['session_id', 'actions'],
        },
        async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
          const { session_id, actions: rawActions } = input as {
            session_id: string
            actions: Array<Record<string, unknown>>
          }
          type BrowserAction = {
            type: string
            url?: string
            selector?: string
            text?: string
            key?: string
            ms?: number
            js?: string
            value?: string
            direction?: string
            amount?: number
            download_path?: string
            file_paths?: string[]
            session_token?: string
            search?: string
            username_selector?: string
            password_selector?: string
            submit_selector?: string
          }
          const actions = rawActions.map(a => stripEmptyActionFields(a) as BrowserAction)

          try {
            const session = requireSession(session_id)
            const { page, context } = session

            const doWork = async (): Promise<ToolResult> => {
              const screenshots: string[] = []
              const evalResults: string[] = []
              const downloads: { filename: string; saved_to: string; size_bytes: number }[] = []

              for (const action of actions) {
                action.type = normalizeActionType(action.type)
                switch (action.type) {
                  case 'goto':
                    if (!action.url) throw new Error('goto requires url')
                    try {
                      await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT() })
                    } catch (err: unknown) {
                      if (!(err as Error).message.includes('imeout')) throw err
                      console.warn(`[browser] nav timeout for ${action.url}, continuing`)
                    }
                    break

                  case 'click':
                    if (!action.selector) throw new Error('click requires selector')
                    await page.click(action.selector, { timeout: SELECTOR_TIMEOUT() })
                    break

                  case 'click_text': {
                    if (!action.text) throw new Error('click_text requires text')
                    const clickTextResult = await safeEvaluate(page, (searchText: string) => {
                      const CLICKABLE = 'a, button, [onclick], [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"], summary, label'

                      function isVisible(el: Element): boolean {
                        const style = window.getComputedStyle(el)
                        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false
                        const rect = el.getBoundingClientRect()
                        return rect.width > 0 && rect.height > 0
                      }

                      function findClickableParent(el: Element): Element | null {
                        let cur: Element | null = el
                        while (cur) {
                          if (cur.matches(CLICKABLE)) return cur
                          cur = cur.parentElement
                        }
                        return null
                      }

                      const lower = searchText.toLowerCase()
                      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
                      const candidates: Element[] = []

                      while (walker.nextNode()) {
                        const node = walker.currentNode as Text
                        if (node.textContent && node.textContent.toLowerCase().includes(lower)) {
                          const parent = node.parentElement
                          if (parent && isVisible(parent)) {
                            candidates.push(parent)
                          }
                        }
                      }

                      if (candidates.length === 0) return { error: `no visible element found containing text: "${searchText}"` }

                      // prefer a candidate that is itself clickable, otherwise walk up
                      for (const el of candidates) {
                        const clickable = el.matches(CLICKABLE) ? el : findClickableParent(el)
                        if (clickable && isVisible(clickable)) {
                          (clickable as HTMLElement).click()
                          return { clicked: clickable.tagName.toLowerCase(), text: (clickable as HTMLElement).innerText?.slice(0, 100) }
                        }
                      }

                      // fallback: just click the first visible candidate directly
                      (candidates[0] as HTMLElement).click()
                      return { clicked: candidates[0].tagName.toLowerCase(), text: (candidates[0] as HTMLElement).innerText?.slice(0, 100), fallback: true }
                    }, action.text) as any

                    if (clickTextResult && 'error' in clickTextResult) {
                      throw new Error(clickTextResult.error as string)
                    }
                    break
                  }

                  case 'type':
                    if (!action.selector) throw new Error('type requires selector')
                    if (!action.text) throw new Error('type requires text')
                    await page.fill(action.selector, action.text)
                    break

                  case 'press':
                    if (!action.key) throw new Error('press requires key')
                    await page.keyboard.press(action.key)
                    break

                  case 'wait':
                    await new Promise(r => setTimeout(r, action.ms || 1000))
                    break

                  case 'wait_for':
                    if (!action.selector) throw new Error('wait_for requires selector')
                    await page.waitForSelector(action.selector, { timeout: action.ms ?? SELECTOR_TIMEOUT() })
                    break

                  case 'evaluate':
                    if (!action.js) throw new Error('evaluate requires js')
                    const result = await safeEvaluate(page, action.js)
                    evalResults.push(JSON.stringify(result))
                    break

                  case 'screenshot': {
                    const path = await takeScreenshot(page)
                    screenshots.push(path)
                    break
                  }

                  case 'scroll':
                    await safeEvaluate(page, ({ dir, amt }: { dir: string; amt: number }) => {
                      window.scrollBy(0, dir === 'up' ? -amt : amt)
                    }, { dir: action.direction ?? 'down', amt: action.amount ?? 500 })
                    break

                  case 'select':
                    if (!action.selector) throw new Error('select requires selector')
                    if (!action.value) throw new Error('select requires value')
                    await page.selectOption(action.selector, action.value)
                    break

                  case 'upload_file': {
                    if (!action.selector) throw new Error('upload_file requires selector')
                    if (!action.file_paths) throw new Error('upload_file requires file_paths')
                    const resolvedPaths = action.file_paths.map(p => expandTilde(p))
                    // validate files exist before attempting upload
                    for (const fp of resolvedPaths) {
                      if (!await Bun.file(fp).exists()) {
                        throw new Error(`upload_file: file not found: ${fp}`)
                      }
                    }
                    // empty array clears the input
                    await page.setInputFiles(action.selector, resolvedPaths, { timeout: SELECTOR_TIMEOUT() })
                    evalResults.push(JSON.stringify({
                      action: 'upload_file',
                      selector: action.selector,
                      files: resolvedPaths,
                      count: resolvedPaths.length,
                    }))
                    break
                  }

                  case 'download': {
                    if (!action.download_path) throw new Error('download requires download_path')
                    if (!action.selector && !action.url) throw new Error('download requires selector or url')
                    const downloadPath = expandTilde(action.download_path)

                    const dlPromise = page.waitForEvent('download', { timeout: DOWNLOAD_TIMEOUT() })
                    try {
                      if (action.selector) {
                        await page.click(action.selector)
                      } else {
                        await page.goto(action.url!, { timeout: DOWNLOAD_TIMEOUT() }).catch((e: Error) => {
                          if (!e.message.includes('Download is starting')) throw e
                        })
                      }

                      const dl = await dlPromise
                      const failure = await dl.failure()
                      if (failure) throw new Error(`download failed: ${failure}`)

                      await mkdir(dirname(downloadPath), { recursive: true })
                      await dl.saveAs(downloadPath)
                      downloads.push({
                        filename: dl.suggestedFilename(),
                        saved_to: downloadPath,
                        size_bytes: Bun.file(downloadPath).size,
                      })
                    } catch (err: unknown) {
                      // cancel the dangling waitForEvent promise if the trigger or download failed
                      dlPromise.catch(() => {})
                      const msg = (err as Error).message ?? String(err)
                      if (msg.includes('imeout')) {
                        throw new Error(`download timed out (${DOWNLOAD_TIMEOUT()}ms) — no download event received. check selector/url or increase downloadTimeout`)
                      }
                      throw err
                    }
                    break
                  }

                  case 'bitwarden_fill': {
                    if (!action.session_token) throw new Error('bitwarden_fill requires session_token')
                    if (!action.search) throw new Error('bitwarden_fill requires search')
                    if (!action.username_selector) throw new Error('bitwarden_fill requires username_selector')
                    if (!action.password_selector) throw new Error('bitwarden_fill requires password_selector')

                    // search the vault
                    let items: any[]
                    try {
                      const result = await $`bw list items --search ${action.search} --session ${action.session_token}`.quiet().text()
                      items = JSON.parse(result)
                    } catch (err: unknown) {
                      const msg = (err as Error).message
                      if (msg.includes('locked') || msg.includes('Vault')) {
                        throw new Error('bitwarden vault is locked — provide a valid session_token from `bw unlock --raw`')
                      }
                      throw new Error('bitwarden search failed — is the session token valid?')
                    }

                    // filter to items with login credentials
                    const loginItems = items.filter((item: any) => item.login?.username && item.login?.password)
                    if (loginItems.length === 0) {
                      throw new Error(`no bitwarden items with login credentials found for "${action.search}" (${items.length} total matches)`)
                    }

                    // use first match
                    const chosen = loginItems[0]
                    const username: string = chosen.login.username
                    const password: string = chosen.login.password
                    const hasTotp: boolean = !!chosen.login.totp

                    // fill credentials directly in the page — password stays in browser context only
                    await page.fill(action.username_selector, username)
                    await page.fill(action.password_selector, password)

                    // submit if selector provided
                    if (action.submit_selector) {
                      await page.click(action.submit_selector, { timeout: SELECTOR_TIMEOUT() })
                      // wait a moment for navigation/submission
                      await new Promise(r => setTimeout(r, 1500))
                    }

                    // clear password from DOM to prevent exfiltration by subsequent page reads
                    // only do this if we already submitted — otherwise the field still needs the password
                    if (action.submit_selector) {
                      try {
                        await page.fill(action.password_selector, '')
                      } catch { /* field may no longer exist after navigation */ }
                    }

                    // return metadata only — NEVER the password
                    evalResults.push(JSON.stringify({
                      action: 'bitwarden_fill',
                      item_name: chosen.name,
                      username,
                      domain: chosen.login.uris?.[0]?.uri ?? null,
                      had_totp: hasTotp,
                      candidates_count: loginItems.length,
                    }))
                    break
                  }

                  default:
                    throw new Error(`unknown action type: ${action.type}`)
                }
              }

              if (!session.persistent) await saveCookies(context)

              const markdownContent = await extractMarkdown(page)
              const resultObj: Record<string, unknown> = {
                session_id,
                url: page.url(),
                title: await page.title(),
                content: markdownContent,
              }
              if (screenshots.length > 0) resultObj.screenshots = screenshots
              if (evalResults.length > 0) resultObj.eval_results = evalResults
              if (downloads.length > 0) resultObj.downloads = downloads

              return { content: JSON.stringify(resultObj, null, 2) }
            }

            return await withTimeout(doWork(), 'browser_interact')
          } catch (err: unknown) {
            // don't nuke the session on error — let user retry
            return { content: `error: ${(err as Error).message}`, is_error: true }
          }
        },
      },

      // --- browser_close ---
      {
        name: 'browser_close',
        description: 'Close a browser session and free resources. For persistent sessions, all state is preserved on disk and can be resumed later with the same session_name. Pass delete: true to permanently delete a persistent session\'s saved state.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Session ID to close' },
            delete: { type: 'boolean', description: 'If true, permanently delete the persistent session data from disk' },
          },
          required: ['session_id'],
        },
        async execute(input: unknown, _ctx: ToolContext): Promise<ToolResult> {
          const { session_id, delete: shouldDelete } = input as { session_id: string; delete?: boolean }

          if (!sessions.has(session_id)) {
            // maybe it's a persistent session on disk that's not active — can still delete it
            if (shouldDelete) {
              const meta = await loadSessionMeta(session_id)
              if (meta) {
                await rm(sessionDataDir(session_id), { recursive: true, force: true })
                return { content: JSON.stringify({ deleted: session_id }) }
              }
            }
            return { content: `session "${session_id}" not found (already closed or expired)`, is_error: true }
          }

          const session = sessions.get(session_id)!
          const wasPersistent = session.persistent

          await closeSession(session_id)

          if (shouldDelete && wasPersistent && session.sessionName) {
            await rm(sessionDataDir(session.sessionName), { recursive: true, force: true })
          }

          const result: Record<string, unknown> = {
            closed: session_id,
            remaining_sessions: [...sessions.keys()],
          }
          if (wasPersistent && !shouldDelete) {
            result.note = 'persistent session state preserved on disk — resume with same session_name'
          }
          if (shouldDelete) {
            result.deleted = true
          }
          return { content: JSON.stringify(result) }
        },
      },
    ],

    async destroy() {
      for (const [id] of sessions) {
        await closeSession(id)
      }
      sessions.clear()
      if (browser) {
        try {
          await Promise.race([
            browser.close(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('browser.close() hung')), CLOSE_TIMEOUT_MS)
            ),
          ])
        } catch {
          try {
            const proc = (browser as any).process?.()
            if (proc) {
              proc.kill('SIGKILL')
              console.warn('[browser] force-killed hung browser on destroy')
            }
          } catch { /* best effort */ }
        }
        browser = null
      }
    },
  }
}
