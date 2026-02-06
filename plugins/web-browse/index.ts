import type { Plugin } from '../../server/plugin.ts'
import type { ToolResult, ToolContext } from '../../server/types.ts'
import { chromium } from 'playwright'

export default function createWebBrowsePlugin(): Plugin {
  return {
    name: 'web-browse',
    description: 'Browse web pages with JavaScript rendering.',

    tools: [
      {
        name: 'web_browse',
        description: 'Load a web page with a headless browser and return clean text content.',
        inputSchema: {
          type: 'object',
          properties: {
            url: { type: 'string', description: 'The URL to browse' },
            selector: { type: 'string', description: 'Optional CSS selector to extract specific content' },
          },
          required: ['url'],
        },
        async execute(input: unknown, context: ToolContext): Promise<ToolResult> {
          const { url, selector } = input as { url: string; selector?: string }

          try {
            const browser = await chromium.launch({ headless: true })
            const page = await browser.newPage()

            // navigate and wait for page to be fully loaded
            await page.goto(url, { waitUntil: 'networkidle' })

            // remove clutter elements
            await page.evaluate(() => {
              const unwanted = document.querySelectorAll(
                'script, style, nav, header, footer, aside, iframe, noscript, [role="navigation"], [role="banner"], [role="complementary"]'
              )
              unwanted.forEach((el) => el.remove())
            })

            // extract content
            let content: string
            if (selector) {
              const element = await page.$(selector)
              if (!element) {
                await browser.close()
                return { content: `error: selector "${selector}" not found`, is_error: true }
              }
              content = (await element.textContent()) || ''
            } else {
              content = await page.evaluate(() => document.body.textContent || '')
            }

            await browser.close()

            // clean up whitespace
            content = content
              .split('\n')
              .map((line) => line.trim())
              .filter((line) => line.length > 0)
              .join('\n')

            // truncate if too long
            const maxLength = 50000
            if (content.length > maxLength) {
              content = content.slice(0, maxLength) + '\n\n[... truncated, content too long]'
            }

            return { content }
          } catch (err: unknown) {
            const error = err as Error
            return { content: `error: ${error.message}`, is_error: true }
          }
        },
      },
    ],
  }
}
