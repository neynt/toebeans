// gmail plugin for toebeans
// read-only access to gmail via OAuth2

import type { Plugin, Tool, ToolResult } from '../../server/types.ts'
import { readFile } from 'node:fs/promises'
import { join } from 'path'
import { homedir } from 'os'

const OAUTH_PATH = join(homedir(), '.toebeans', 'secrets', 'gmail-oauth.json')
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

interface OAuthCreds {
  client_id: string
  client_secret: string
  refresh_token: string
  token_uri: string
}

let creds: OAuthCreds | null = null
let accessToken: string | null = null
let tokenExpiresAt = 0

async function loadCreds(): Promise<OAuthCreds> {
  if (creds) return creds
  creds = JSON.parse(await readFile(OAUTH_PATH, 'utf-8'))
  return creds!
}

async function getAccessToken(): Promise<string> {
  if (accessToken && Date.now() < tokenExpiresAt - 30_000) {
    return accessToken
  }

  const c = await loadCreds()
  const res = await fetch(c.token_uri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: c.client_id,
      client_secret: c.client_secret,
      refresh_token: c.refresh_token,
      grant_type: 'refresh_token',
    }),
  })

  if (!res.ok) {
    const text = await res.text()
    throw new Error(`token refresh failed (${res.status}): ${text}`)
  }

  const data = await res.json() as { access_token: string; expires_in: number }
  accessToken = data.access_token
  tokenExpiresAt = Date.now() + data.expires_in * 1000
  return accessToken
}

async function gmailGet(path: string, params?: Record<string, string>): Promise<unknown> {
  const token = await getAccessToken()
  const url = new URL(`${GMAIL_API}${path}`)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v)
    }
  }
  const res = await fetch(url.toString(), {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`gmail API error (${res.status}): ${text}`)
  }
  return res.json()
}

function getHeader(headers: { name: string; value: string }[], name: string): string {
  return headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value ?? ''
}

function decodeBase64Url(data: string): string {
  const base64 = data.replace(/-/g, '+').replace(/_/g, '/')
  return Buffer.from(base64, 'base64').toString('utf-8')
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function extractBody(payload: any): string {
  // direct body
  if (payload.body?.data) {
    const decoded = decodeBase64Url(payload.body.data)
    if (payload.mimeType === 'text/plain') return decoded
    if (payload.mimeType === 'text/html') return stripHtml(decoded)
  }

  // multipart — prefer text/plain, fall back to text/html
  if (payload.parts) {
    let plainText = ''
    let htmlText = ''
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) {
        plainText += decodeBase64Url(part.body.data)
      } else if (part.mimeType === 'text/html' && part.body?.data) {
        htmlText += decodeBase64Url(part.body.data)
      } else if (part.parts) {
        // nested multipart (e.g. multipart/alternative inside multipart/mixed)
        const nested = extractBody(part)
        if (nested) return nested
      }
    }
    if (plainText) return plainText
    if (htmlText) return stripHtml(htmlText)
  }

  return '(no body)'
}

const tools: Tool[] = [
  {
    name: 'gmail_labels',
    description: 'List all Gmail labels with their IDs and names.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    async execute(): Promise<ToolResult> {
      try {
        const data = await gmailGet('/labels') as {
          labels: { id: string; name: string; type: string }[]
        }
        const lines = data.labels
          .sort((a, b) => a.name.localeCompare(b.name))
          .map(l => `${l.name} (${l.id})`)
        return { content: lines.join('\n') }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to list labels: ${error.message}`, is_error: true }
      }
    },
  },
  {
    name: 'gmail_search',
    description: 'Search Gmail messages. Returns id, threadId, from, to, subject, date, and snippet for each match.',
    inputSchema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Gmail search query (e.g. "from:someone", "is:unread", "subject:hello")',
        },
        max_results: {
          type: 'number',
          description: 'Maximum number of results (default 10)',
        },
      },
      required: ['query'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const { query, max_results = 10 } = input as { query: string; max_results?: number }

      try {
        // search for message IDs
        const listData = await gmailGet('/messages', {
          q: query,
          maxResults: String(max_results),
        }) as { messages?: { id: string; threadId: string }[] }

        if (!listData.messages?.length) {
          return { content: 'no messages found' }
        }

        // batch-fetch metadata for each message
        const results: string[] = []
        for (const msg of listData.messages) {
          const detail = await gmailGet(`/messages/${msg.id}`, {
            format: 'metadata',
            metadataHeaders: 'From,To,Subject,Date',
          }) as {
            id: string
            threadId: string
            snippet: string
            payload: { headers: { name: string; value: string }[] }
          }

          const headers = detail.payload.headers
          results.push([
            `ID: ${detail.id}`,
            `Thread: ${detail.threadId}`,
            `From: ${getHeader(headers, 'From')}`,
            `To: ${getHeader(headers, 'To')}`,
            `Subject: ${getHeader(headers, 'Subject')}`,
            `Date: ${getHeader(headers, 'Date')}`,
            `Snippet: ${detail.snippet}`,
          ].join('\n'))
        }

        return { content: results.join('\n\n---\n\n') }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to search messages: ${error.message}`, is_error: true }
      }
    },
  },
  {
    name: 'gmail_read',
    description: 'Read a full Gmail message by ID. Returns from, to, cc, subject, date, and body text.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'string',
          description: 'The message ID (from gmail_search results)',
        },
      },
      required: ['message_id'],
    },
    async execute(input: unknown): Promise<ToolResult> {
      const { message_id } = input as { message_id: string }

      try {
        const msg = await gmailGet(`/messages/${message_id}`, {
          format: 'full',
        }) as {
          id: string
          threadId: string
          payload: {
            headers: { name: string; value: string }[]
            mimeType: string
            body?: { data?: string }
            parts?: any[]
          }
        }

        const headers = msg.payload.headers
        const body = extractBody(msg.payload)

        const lines = [
          `From: ${getHeader(headers, 'From')}`,
          `To: ${getHeader(headers, 'To')}`,
          `CC: ${getHeader(headers, 'Cc')}`,
          `Subject: ${getHeader(headers, 'Subject')}`,
          `Date: ${getHeader(headers, 'Date')}`,
          ``,
          body,
        ]

        return { content: lines.join('\n') }
      } catch (err: unknown) {
        const error = err as { message?: string }
        return { content: `failed to read message: ${error.message}`, is_error: true }
      }
    },
  },
]

export default function create(): Plugin {
  return {
    name: 'gmail',
    description: 'read-only access to gmail via OAuth2',
    tools,
  }
}
