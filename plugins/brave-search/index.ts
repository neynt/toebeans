// brave-search plugin for toebeans
// searches the web using the Brave Search API

import type { Plugin } from '../../server/plugin.ts'
import type { Tool, ToolResult } from '../../server/types.ts'

interface BraveSearchConfig {
  apiKey?: string
}

interface BraveWebResult {
  title: string
  url: string
  description: string
  extra_snippets?: string[]
}

interface BraveSearchResponse {
  query: { original: string; more_results_available: boolean }
  web?: { results: BraveWebResult[] }
}

const API_BASE = 'https://api.search.brave.com/res/v1/web/search'

export default function create(): Plugin {
  let config: BraveSearchConfig | null = null

  function getApiKey(): string | undefined {
    return config?.apiKey || process.env.BRAVE_SEARCH_API_KEY
  }

  const tools: Tool[] = [
    {
      name: 'web_search',
      description: 'Search the web using Brave Search. Returns titles, URLs, and snippets.',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          count: { type: 'number', description: 'Number of results (1-20, default 10)' },
          offset: { type: 'number', description: 'Pagination offset (0-9, default 0)' },
          freshness: {
            type: 'string',
            description: 'Filter by freshness: pd (past day), pw (past week), pm (past month), py (past year)',
          },
          country: { type: 'string', description: '2-letter country code for regional results' },
        },
        required: ['query'],
      },
      async execute(input: unknown): Promise<ToolResult> {
        const apiKey = getApiKey()
        if (!apiKey) {
          return { content: 'brave search api key not configured. set apiKey in plugin config or BRAVE_SEARCH_API_KEY env var.', is_error: true }
        }

        const { query, count = 10, offset, freshness, country } = input as {
          query: string
          count?: number
          offset?: number
          freshness?: string
          country?: string
        }

        const params = new URLSearchParams({ q: query, count: String(count) })
        if (offset) params.set('offset', String(offset))
        if (freshness) params.set('freshness', freshness)
        if (country) params.set('country', country)

        try {
          const response = await fetch(`${API_BASE}?${params}`, {
            headers: {
              'Accept': 'application/json',
              'Accept-Encoding': 'gzip',
              'X-Subscription-Token': apiKey,
            },
          })

          if (!response.ok) {
            const errorText = await response.text()
            return { content: `brave search api error: ${response.status} - ${errorText}`, is_error: true }
          }

          const data = await response.json() as BraveSearchResponse
          const results = data.web?.results ?? []

          if (results.length === 0) {
            return { content: 'no results found.' }
          }

          const formatted = results.map((r, i) =>
            `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.description}`
          ).join('\n\n')

          return { content: formatted }
        } catch (err: unknown) {
          const error = err as { message?: string }
          return { content: `brave search failed: ${error.message}`, is_error: true }
        }
      },
    },
  ]

  return {
    name: 'brave-search',
    description: 'search the web using brave search api',

    tools,

    async init(cfg: unknown) {
      config = cfg as BraveSearchConfig
      if (!getApiKey()) {
        console.warn('brave-search: no api key provided (set apiKey in config or BRAVE_SEARCH_API_KEY env var)')
      }
    },
  }
}
