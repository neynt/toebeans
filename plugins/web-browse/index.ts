import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult, ToolContext } from '../../server/types.ts'
import { getDataDir, getWorkspaceDir } from '../../server/session.ts'
import { chromium } from 'patchright'
import type { Browser, BrowserContext, Page } from 'patchright'

import TurndownService from 'turndown'
import { join } from 'path'
import { mkdir } from 'node:fs/promises'

// --- plugin config ---

interface WebBrowseConfig {
  locale?: string
  timezone?: string
  sessionTimeoutMs?: number
  navigationTimeout?: number
  maxContentLength?: number
  remoteDebuggingPort?: number
}

let pluginConfig: WebBrowseConfig = {}

const HARD_TIMEOUT_MS = 45000

// --- cookie persistence ---

const COOKIE_PATH = join(getDataDir(), 'secrets', 'browser-cookies.json')

async function loadCookies(): Promise<any[]> {
  try {
    const file = Bun.file(COOKIE_PATH)
    if (await file.exists()) {
      return await file.json()
    }
  } catch (err) {
    console.warn('failed to load cookies:', err)
  }
  return []
}

async function saveCookies(context: BrowserContext): Promise<void> {
  try {
    const cookies = await context.cookies()
    await mkdir(join(getDataDir(), 'secrets'), { recursive: true })
    await Bun.write(COOKIE_PATH, JSON.stringify(cookies, null, 2))
  } catch (err) {
    console.warn('failed to save cookies:', err)
  }
}

// --- stealth constants ---

const CHROME_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

const WEBGL_SPOOF_SCRIPT = `
  const spoofParams = {
    37445: 'Google Inc. (NVIDIA)',
    37446: 'ANGLE (NVIDIA, NVIDIA GeForce GTX 1650 SUPER, OpenGL 4.5)',
  };
  const origGetParameter = WebGLRenderingContext.prototype.getParameter;
  WebGLRenderingContext.prototype.getParameter = function(param) {
    if (spoofParams[param] !== undefined) return spoofParams[param];
    return origGetParameter.call(this, param);
  };
  if (typeof WebGL2RenderingContext !== 'undefined') {
    const origGetParameter2 = WebGL2RenderingContext.prototype.getParameter;
    WebGL2RenderingContext.prototype.getParameter = function(param) {
      if (spoofParams[param] !== undefined) return spoofParams[param];
      return origGetParameter2.call(this, param);
    };
  }
`

// --- browser pool ---

let browserPool: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (!browserPool) {
    const args = ['--disable-blink-features=AutomationControlled']
    if (pluginConfig.remoteDebuggingPort) {
      args.push(`--remote-debugging-port=${pluginConfig.remoteDebuggingPort}`)
    }
    browserPool = await chromium.launch({
      channel: 'chrome',
      headless: true,
      args,
    })
  }
  return browserPool
}

async function createContextWithCookies(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: pluginConfig.locale ?? 'en-US',
    timezoneId: pluginConfig.timezone ?? 'America/New_York',
    userAgent: CHROME_USER_AGENT,
  })
  await context.addInitScript(WEBGL_SPOOF_SCRIPT)
  const cookies = await loadCookies()
  if (cookies.length > 0) {
    await context.addCookies(cookies)
  }
  return context
}

// --- session management ---

interface PageSession {
  context: BrowserContext
  page: Page
  lastActivity: number
  expiryTimer: ReturnType<typeof setTimeout>
}

const sessions = new Map<string, PageSession>()
let sessionCounter = 0

function generateSessionId(): string {
  return `browse-${++sessionCounter}-${Date.now().toString(36)}`
}

function getSessionTimeout(): number {
  return pluginConfig.sessionTimeoutMs ?? 300000
}

function touchSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  session.lastActivity = Date.now()
  clearTimeout(session.expiryTimer)
  session.expiryTimer = setTimeout(() => expireSession(id), getSessionTimeout())
}

async function expireSession(id: string): Promise<void> {
  const session = sessions.get(id)
  if (!session) return
  try {
    await saveCookies(session.context)
    await session.context.close()
  } catch { /* already closed */ }
  sessions.delete(id)
}

async function getOrCreateSession(sessionId?: string): Promise<{ id: string; session: PageSession }> {
  if (sessionId && sessions.has(sessionId)) {
    const session = sessions.get(sessionId)!
    touchSession(sessionId)
    return { id: sessionId, session }
  }

  const browser = await getBrowser()
  const context = await createContextWithCookies(browser)
  const page = await context.newPage()
  const id = sessionId || generateSessionId()

  const session: PageSession = {
    context,
    page,
    lastActivity: Date.now(),
    expiryTimer: setTimeout(() => expireSession(id), getSessionTimeout()),
  }
  sessions.set(id, session)
  return { id, session }
}

// --- html to markdown ---

function htmlToMarkdown(html: string): string {
  const turndownService = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
  })
  let content = turndownService.turndown(html)

  content = content
    .replace(/!\[([^\]]*)\]\(data:[^)]+\)/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => !/^\*(\s+\*)*\s*$/.test(line))
    .join('\n')

  content = content.replace(/\n\n\n+/g, '\n\n')

  const maxLength = pluginConfig.maxContentLength ?? 50000
  if (content.length > maxLength) {
    content = content.slice(0, maxLength) + '\n\n[... truncated, content too long]'
  }

  return content
}

async function extractPageMarkdown(page: Page, selector?: string): Promise<string> {
  await page.evaluate(() => {
    const unwanted = document.querySelectorAll(
      'script, style, nav, header, footer, aside, iframe, noscript, svg, canvas, map, [aria-hidden="true"], [role="navigation"], [role="banner"], [role="complementary"]'
    )
    unwanted.forEach((el) => el.remove())
    const dataImages = document.querySelectorAll('img[src^="data:"]')
    dataImages.forEach((el) => el.remove())
  })

  let html: string
  if (selector) {
    const element = await page.$(selector)
    if (!element) {
      throw new Error(`selector "${selector}" not found`)
    }
    html = (await element.innerHTML()) || ''
  } else {
    html = await page.evaluate(() => document.body.innerHTML || '')
  }

  return htmlToMarkdown(html)
}

// --- screenshot helpers ---

async function getScreenshotDir(): Promise<string> {
  const dir = join(getWorkspaceDir(), 'images')
  await mkdir(dir, { recursive: true })
  return dir
}

async function takeScreenshot(page: Page): Promise<string> {
  const dir = await getScreenshotDir()
  const filename = `screenshot-${Date.now()}.png`
  const filepath = join(dir, filename)
  await page.screenshot({ path: filepath, fullPage: false })
  return filepath
}

// --- plugin ---

export default function createWebBrowsePlugin(): Plugin {
  return {
    name: 'web-browse',
    description: 'Browse web pages with JavaScript rendering. Supports stateless browsing (web_browse), interactive sessions (web_interact), and screenshots (web_screenshot).',

    async init(cfg: unknown) {
      pluginConfig = (cfg as WebBrowseConfig) ?? {}
    },

    tools: [
      // --- web_browse (existing, now with cookies) ---
      {
        name: 'web_browse',
        description: 'Load a web page with a headless browser and return markdown content. Stateless — each call is independent.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to browse' },
            selector: { type: 'string', description: 'Optional CSS selector to extract specific content' },
            timeout: { type: 'number', description: 'Optional navigation timeout in milliseconds (default: 15000)' },
          },
          required: ['url'],
        },
        async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
          const navTimeout = pluginConfig.navigationTimeout ?? 15000
          const { url, selector, timeout = navTimeout } = input as { url: string; selector?: string; timeout?: number }

          const browser = await getBrowser()
          const context = await createContextWithCookies(browser)
          const page = await context.newPage()

          const doWork = async (): Promise<ToolResult> => {
            try {
              await page.goto(url, { waitUntil: 'domcontentloaded', timeout })
            } catch (err: unknown) {
              const error = err as Error
              if (error.message.includes('Timeout') || error.message.includes('timeout')) {
                console.warn(`navigation timeout for ${url}, using partial content`)
              } else {
                throw err
              }
            }

            const content = await extractPageMarkdown(page, selector)
            await saveCookies(context)
            await context.close()
            return { content }
          }

          try {
            return await Promise.race([
              doWork(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`hard timeout: web_browse exceeded ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS)
              ),
            ])
          } catch (err: unknown) {
            try { await context.close() } catch { /* already closed */ }
            const error = err as Error
            return { content: `error: ${error.message}`, is_error: true }
          }
        },
      },

      // --- web_interact ---
      {
        name: 'web_interact',
        description: 'Interact with a web page using a persistent browser session. Perform sequential actions like navigation, clicking, typing, and more. Returns markdown of the final page state.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Reuse an existing session. Omit to create a new one.' },
            actions: {
              type: 'array',
              description: 'Sequential actions to perform',
              items: {
                type: 'object',
                properties: {
                  type: { type: 'string', enum: ['goto', 'click', 'type', 'press', 'wait', 'wait_for', 'evaluate', 'screenshot'], description: 'Action type' },
                  url: { type: 'string', description: 'URL for goto action' },
                  selector: { type: 'string', description: 'CSS selector for click/type/wait_for actions' },
                  text: { type: 'string', description: 'Text for type action' },
                  key: { type: 'string', description: 'Key for press action (e.g. "Enter")' },
                  ms: { type: 'number', description: 'Milliseconds for wait action' },
                  js: { type: 'string', description: 'JavaScript code for evaluate action' },
                },
                required: ['type'],
              },
            },
          },
          required: ['actions'],
        },
        async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
          const { session_id, actions } = input as {
            session_id?: string
            actions: Array<{
              type: 'goto' | 'click' | 'type' | 'press' | 'wait' | 'wait_for' | 'evaluate' | 'screenshot'
              url?: string
              selector?: string
              text?: string
              key?: string
              ms?: number
              js?: string
            }>
          }

          const { id, session } = await getOrCreateSession(session_id)
          const { page, context } = session

          const doWork = async (): Promise<ToolResult> => {
            const screenshots: string[] = []
            const evalResults: string[] = []

            for (const action of actions) {
              switch (action.type) {
                case 'goto':
                  if (!action.url) throw new Error('goto action requires url')
                  try {
                    await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: pluginConfig.navigationTimeout ?? 15000 })
                  } catch (err: unknown) {
                    const error = err as Error
                    if (error.message.includes('Timeout') || error.message.includes('timeout')) {
                      console.warn(`navigation timeout for ${action.url}, continuing`)
                    } else {
                      throw err
                    }
                  }
                  break
                case 'click':
                  if (!action.selector) throw new Error('click action requires selector')
                  await page.click(action.selector)
                  break
                case 'type':
                  if (!action.selector) throw new Error('type action requires selector')
                  if (!action.text) throw new Error('type action requires text')
                  await page.fill(action.selector, action.text)
                  break
                case 'press':
                  if (!action.key) throw new Error('press action requires key')
                  await page.keyboard.press(action.key)
                  break
                case 'wait':
                  await new Promise((resolve) => setTimeout(resolve, action.ms || 1000))
                  break
                case 'wait_for':
                  if (!action.selector) throw new Error('wait_for action requires selector')
                  await page.waitForSelector(action.selector, { timeout: pluginConfig.navigationTimeout ?? 15000 })
                  break
                case 'evaluate':
                  if (!action.js) throw new Error('evaluate action requires js')
                  const result = await page.evaluate(action.js)
                  evalResults.push(JSON.stringify(result))
                  break
                case 'screenshot': {
                  const path = await takeScreenshot(page)
                  screenshots.push(path)
                  break
                }
                default:
                  throw new Error(`unknown action type: ${(action as any).type}`)
              }
            }

            await saveCookies(context)
            touchSession(id)

            const markdownContent = await extractPageMarkdown(page)
            const resultObj: Record<string, any> = {
              session_id: id,
              url: page.url(),
              title: await page.title(),
              content: markdownContent,
            }
            if (screenshots.length > 0) resultObj.screenshots = screenshots
            if (evalResults.length > 0) resultObj.eval_results = evalResults

            return { content: JSON.stringify(resultObj, null, 2) }
          }

          try {
            return await Promise.race([
              doWork(),
              new Promise<never>((_, reject) =>
                setTimeout(() => reject(new Error(`hard timeout: web_interact exceeded ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS)
              ),
            ])
          } catch (err: unknown) {
            try { await expireSession(id) } catch { /* already closed */ }
            const error = err as Error
            return { content: `error: ${error.message}`, is_error: true }
          }
        },
      },

      // --- web_screenshot ---
      {
        name: 'web_screenshot',
        description: 'Take a screenshot of a web page. Provide either a session_id to screenshot an existing session, or a url to navigate and screenshot.',
        inputSchema: {
          type: 'object',
          properties: {
            session_id: { type: 'string', description: 'Screenshot an existing session' },
            url: { type: 'string', description: 'URL to navigate to and screenshot' },
          },
        },
        async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
          const { session_id, url } = input as { session_id?: string; url?: string }

          if (!session_id && !url) {
            return { content: 'error: provide either session_id or url', is_error: true }
          }

          // if session_id given, use that session
          if (session_id && sessions.has(session_id)) {
            const session = sessions.get(session_id)!
            touchSession(session_id)

            const doWork = async (): Promise<ToolResult> => {
              const path = await takeScreenshot(session.page)
              await saveCookies(session.context)
              return { content: JSON.stringify({ session_id, path, url: session.page.url() }) }
            }

            try {
              return await Promise.race([
                doWork(),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`hard timeout: web_screenshot exceeded ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS)
                ),
              ])
            } catch (err: unknown) {
              try { await expireSession(session_id) } catch { /* already closed */ }
              return { content: `error: ${(err as Error).message}`, is_error: true }
            }
          }

          // otherwise navigate to url in a temporary context
          if (url) {
            const browser = await getBrowser()
            const context = await createContextWithCookies(browser)
            const page = await context.newPage()

            const doWork = async (): Promise<ToolResult> => {
              try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: pluginConfig.navigationTimeout ?? 15000 })
              } catch (err: unknown) {
                const error = err as Error
                if (error.message.includes('Timeout') || error.message.includes('timeout')) {
                  console.warn(`navigation timeout for ${url}, screenshotting partial`)
                } else {
                  throw err
                }
              }

              const path = await takeScreenshot(page)
              await saveCookies(context)
              await context.close()
              return { content: JSON.stringify({ path, url }) }
            }

            try {
              return await Promise.race([
                doWork(),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error(`hard timeout: web_screenshot exceeded ${HARD_TIMEOUT_MS}ms`)), HARD_TIMEOUT_MS)
                ),
              ])
            } catch (err: unknown) {
              try { await context.close() } catch { /* already closed */ }
              return { content: `error: ${(err as Error).message}`, is_error: true }
            }
          }

          // session_id given but not found
          return { content: `error: session "${session_id}" not found`, is_error: true }
        },
      },
    ],

    async destroy() {
      // clean up all sessions
      for (const [id] of sessions) {
        await expireSession(id)
      }
      sessions.clear()

      if (browserPool) {
        await browserPool.close()
        browserPool = null
      }
    },
  }
}
