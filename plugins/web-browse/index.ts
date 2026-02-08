import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult, ToolContext } from '../../server/types.ts'
import { getDataDir, getWorkspaceDir } from '../../server/session.ts'
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright'
import TurndownService from 'turndown'
import { join } from 'path'
import { mkdir } from 'node:fs/promises'

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

// --- browser pool ---

let browserPool: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (!browserPool) {
    browserPool = await chromium.launch({ headless: true })
  }
  return browserPool
}

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

async function createContextWithCookies(browser: Browser): Promise<BrowserContext> {
  const context = await browser.newContext({ userAgent: USER_AGENT })
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

const SESSION_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
const sessions = new Map<string, PageSession>()
let sessionCounter = 0

function generateSessionId(): string {
  return `browse-${++sessionCounter}-${Date.now().toString(36)}`
}

function touchSession(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  session.lastActivity = Date.now()
  clearTimeout(session.expiryTimer)
  session.expiryTimer = setTimeout(() => expireSession(id), SESSION_TIMEOUT_MS)
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
    expiryTimer: setTimeout(() => expireSession(id), SESSION_TIMEOUT_MS),
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

  const maxLength = 50000
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
            timeout: { type: 'number', description: 'Optional navigation timeout in milliseconds (default: 30000)' },
          },
          required: ['url'],
        },
        async execute(input: unknown, _context: ToolContext): Promise<ToolResult> {
          const { url, selector, timeout = 30000 } = input as { url: string; selector?: string; timeout?: number }

          const browser = await getBrowser()
          const context = await createContextWithCookies(browser)
          const page = await context.newPage()

          try {
            try {
              await page.goto(url, { waitUntil: 'networkidle', timeout })
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
          } catch (err: unknown) {
            await saveCookies(context)
            await context.close()
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
          const screenshots: string[] = []
          const evalResults: string[] = []

          try {
            for (const action of actions) {
              switch (action.type) {
                case 'goto':
                  if (!action.url) throw new Error('goto action requires url')
                  try {
                    await page.goto(action.url, { waitUntil: 'networkidle', timeout: 30000 })
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
                  await page.waitForSelector(action.selector, { timeout: 30000 })
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

            const content = await extractPageMarkdown(page)
            const result: Record<string, any> = {
              session_id: id,
              url: page.url(),
              title: await page.title(),
              content,
            }
            if (screenshots.length > 0) result.screenshots = screenshots
            if (evalResults.length > 0) result.eval_results = evalResults

            return { content: JSON.stringify(result, null, 2) }
          } catch (err: unknown) {
            await saveCookies(context)
            touchSession(id)
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
            try {
              const path = await takeScreenshot(session.page)
              await saveCookies(session.context)
              return { content: JSON.stringify({ session_id, path, url: session.page.url() }) }
            } catch (err: unknown) {
              return { content: `error: ${(err as Error).message}`, is_error: true }
            }
          }

          // otherwise navigate to url in a temporary context
          if (url) {
            const browser = await getBrowser()
            const context = await createContextWithCookies(browser)
            const page = await context.newPage()

            try {
              try {
                await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 })
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
            } catch (err: unknown) {
              await context.close()
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
