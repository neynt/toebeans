import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult, ToolContext } from '../../server/types.ts'
import { chromium, type Browser } from 'playwright'
import TurndownService from 'turndown'

let browserPool: Browser | null = null

async function getBrowser(): Promise<Browser> {
  if (!browserPool) {
    browserPool = await chromium.launch({ headless: true })
  }
  return browserPool
}

export default function createWebBrowsePlugin(): Plugin {
  return {
    name: 'web-browse',
    description: 'Browse web pages with JavaScript rendering.',

    tools: [
      {
        name: 'web_browse',
        description: 'Load a web page with a headless browser and return markdown content.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to browse' },
            selector: { type: 'string', description: 'Optional CSS selector to extract specific content' },
            timeout: { type: 'number', description: 'Optional navigation timeout in milliseconds (default: 30000)' },
          },
          required: ['url'],
        },
        async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
          const { url, selector, timeout = 30000 } = input as { url: string; selector?: string; timeout?: number }

          const browser = await getBrowser()
          const browserContext = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
          })
          const page = await browserContext.newPage()

          try {
            // navigate with timeout, return partial content on timeout
            try {
              await page.goto(url, { waitUntil: 'networkidle', timeout })
            } catch (err: unknown) {
              const error = err as Error
              if (error.message.includes('Timeout') || error.message.includes('timeout')) {
                // timeout occurred, but continue with whatever loaded
                console.warn(`navigation timeout for ${url}, using partial content`)
              } else {
                throw err
              }
            }

            // remove clutter elements
            await page.evaluate(() => {
              const unwanted = document.querySelectorAll(
                'script, style, nav, header, footer, aside, iframe, noscript, svg, canvas, map, [aria-hidden="true"], [role="navigation"], [role="banner"], [role="complementary"]'
              )
              unwanted.forEach((el) => el.remove())

              // remove images with data URIs
              const dataImages = document.querySelectorAll('img[src^="data:"]')
              dataImages.forEach((el) => el.remove())
            })

            // extract HTML content
            let html: string
            if (selector) {
              const element = await page.$(selector)
              if (!element) {
                await browserContext.close()
                return { content: `error: selector "${selector}" not found`, is_error: true }
              }
              html = (await element.innerHTML()) || ''
            } else {
              html = await page.evaluate(() => document.body.innerHTML || '')
            }

            await browserContext.close()

            // convert HTML to markdown
            const turndownService = new TurndownService({
              headingStyle: 'atx',
              codeBlockStyle: 'fenced',
            })
            let content = turndownService.turndown(html)

            // post-process markdown
            content = content
              // remove image markdown with data URIs
              .replace(/!\[([^\]]*)\]\(data:[^)]+\)/g, '')
              // split into lines for further processing
              .split('\n')
              .map((line) => line.trim())
              // remove empty list markers from stripped content
              .filter((line) => {
                const isEmptyMarker = /^\*(\s+\*)*\s*$/.test(line)
                return !isEmptyMarker
              })
              .join('\n')

            // collapse runs of 3+ blank lines into 2
            content = content.replace(/\n\n\n+/g, '\n\n')

            // truncate if too long
            const maxLength = 50000
            if (content.length > maxLength) {
              content = content.slice(0, maxLength) + '\n\n[... truncated, content too long]'
            }

            return { content }
          } catch (err: unknown) {
            await browserContext.close()
            const error = err as Error
            return { content: `error: ${error.message}`, is_error: true }
          }
        },
      },
    ],

    async destroy() {
      if (browserPool) {
        await browserPool.close()
        browserPool = null
      }
    },
  }
}
