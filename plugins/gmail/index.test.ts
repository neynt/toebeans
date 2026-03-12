import { describe, test, expect, beforeAll } from 'bun:test'
import { encodeBase64Url, decodeBase64Url, stripHtml, extractBody, getHeader } from './index.ts'
import type { Plugin } from '../../server/plugin.ts'

describe('encodeBase64Url / decodeBase64Url', () => {
  test('round-trips plain text', () => {
    const original = 'Hello, world!'
    expect(decodeBase64Url(encodeBase64Url(original))).toBe(original)
  })

  test('round-trips unicode', () => {
    const original = 'Subject: 日本語テスト'
    expect(decodeBase64Url(encodeBase64Url(original))).toBe(original)
  })

  test('encodes without padding or unsafe chars', () => {
    const encoded = encodeBase64Url('test string with special chars: +/=')
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
  })

  test('round-trips multiline email body', () => {
    const body = 'From: test@example.com\r\nTo: other@example.com\r\n\r\nBody text here.'
    expect(decodeBase64Url(encodeBase64Url(body))).toBe(body)
  })
})

describe('getHeader', () => {
  const headers = [
    { name: 'From', value: 'sender@example.com' },
    { name: 'To', value: 'recipient@example.com' },
    { name: 'Subject', value: 'Test Subject' },
    { name: 'Message-ID', value: '<abc123@mail.example.com>' },
  ]

  test('finds header case-insensitively', () => {
    expect(getHeader(headers, 'from')).toBe('sender@example.com')
    expect(getHeader(headers, 'FROM')).toBe('sender@example.com')
    expect(getHeader(headers, 'From')).toBe('sender@example.com')
  })

  test('returns empty string for missing header', () => {
    expect(getHeader(headers, 'Cc')).toBe('')
    expect(getHeader(headers, 'X-Custom')).toBe('')
  })

  test('finds Message-ID with hyphen', () => {
    expect(getHeader(headers, 'message-id')).toBe('<abc123@mail.example.com>')
  })

  test('handles empty headers array', () => {
    expect(getHeader([], 'From')).toBe('')
  })
})

describe('stripHtml', () => {
  test('strips basic tags', () => {
    expect(stripHtml('<p>Hello</p>')).toBe('Hello')
  })

  test('converts br to newline', () => {
    expect(stripHtml('line1<br>line2<br/>line3')).toBe('line1\nline2\nline3')
  })

  test('converts closing p and div to newlines', () => {
    expect(stripHtml('<p>para1</p><p>para2</p>')).toBe('para1\n\npara2')
  })

  test('strips style and script blocks entirely', () => {
    const html = '<style>body { color: red; }</style><p>visible</p><script>alert("hi")</script>'
    expect(stripHtml(html)).toBe('visible')
  })

  test('decodes HTML entities', () => {
    expect(stripHtml('&amp; &lt; &gt; &quot; &#39; &nbsp;')).toBe('& < > " \'')
  })

  test('collapses excessive newlines', () => {
    expect(stripHtml('<p>a</p>\n\n\n\n<p>b</p>')).toBe('a\n\nb')
  })
})

describe('extractBody', () => {
  test('extracts text/plain direct body', () => {
    const payload = {
      mimeType: 'text/plain',
      body: { data: encodeBase64Url('plain text content') },
    }
    expect(extractBody(payload)).toBe('plain text content')
  })

  test('extracts and strips text/html direct body', () => {
    const payload = {
      mimeType: 'text/html',
      body: { data: encodeBase64Url('<p>html content</p>') },
    }
    expect(extractBody(payload)).toBe('html content')
  })

  test('prefers text/plain in multipart', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      body: {},
      parts: [
        { mimeType: 'text/plain', body: { data: encodeBase64Url('plain version') } },
        { mimeType: 'text/html', body: { data: encodeBase64Url('<b>html version</b>') } },
      ],
    }
    expect(extractBody(payload)).toBe('plain version')
  })

  test('falls back to html in multipart when no plain', () => {
    const payload = {
      mimeType: 'multipart/alternative',
      body: {},
      parts: [
        { mimeType: 'text/html', body: { data: encodeBase64Url('<b>html only</b>') } },
      ],
    }
    expect(extractBody(payload)).toBe('html only')
  })

  test('handles nested multipart', () => {
    const payload = {
      mimeType: 'multipart/mixed',
      body: {},
      parts: [
        {
          mimeType: 'multipart/alternative',
          body: {},
          parts: [
            { mimeType: 'text/plain', body: { data: encodeBase64Url('nested plain') } },
            { mimeType: 'text/html', body: { data: encodeBase64Url('<p>nested html</p>') } },
          ],
        },
        { mimeType: 'application/pdf', body: {} },
      ],
    }
    expect(extractBody(payload)).toBe('nested plain')
  })

  test('returns (no body) when empty', () => {
    expect(extractBody({ mimeType: 'text/plain', body: {} })).toBe('(no body)')
  })
})

describe('gmail plugin tool registration', () => {
  let plugin: Plugin

  beforeAll(async () => {
    // import the plugin factory — this doesn't make API calls
    const create = (await import('./index.ts')).default
    plugin = create()
  })

  test('exports all expected tools', () => {
    const toolNames = plugin.tools!.map(t => t.name).sort()
    expect(toolNames).toEqual([
      'gmail_draft_create',
      'gmail_draft_delete',
      'gmail_draft_read',
      'gmail_draft_update',
      'gmail_drafts_list',
      'gmail_labels',
      'gmail_modify_labels',
      'gmail_read',
      'gmail_search',
      'gmail_send',
    ])
  })

  test('gmail_draft_create requires to, subject, body', () => {
    const tool = plugin.tools!.find(t => t.name === 'gmail_draft_create')!
    const schema = tool.inputSchema as { required: string[] }
    expect(schema.required).toEqual(['to', 'subject', 'body'])
  })

  test('gmail_draft_update requires draft_id, to, subject, body', () => {
    const tool = plugin.tools!.find(t => t.name === 'gmail_draft_update')!
    const schema = tool.inputSchema as { required: string[] }
    expect(schema.required).toEqual(['draft_id', 'to', 'subject', 'body'])
  })

  test('gmail_draft_read requires draft_id', () => {
    const tool = plugin.tools!.find(t => t.name === 'gmail_draft_read')!
    const schema = tool.inputSchema as { required: string[] }
    expect(schema.required).toEqual(['draft_id'])
  })

  test('gmail_draft_delete requires draft_id', () => {
    const tool = plugin.tools!.find(t => t.name === 'gmail_draft_delete')!
    const schema = tool.inputSchema as { required: string[] }
    expect(schema.required).toEqual(['draft_id'])
  })

  test('gmail_drafts_list has no required fields', () => {
    const tool = plugin.tools!.find(t => t.name === 'gmail_drafts_list')!
    const schema = tool.inputSchema as { required?: string[] }
    expect(schema.required).toBeUndefined()
  })

  test('gmail_draft_create description mentions gmail_draft_update', () => {
    const tool = plugin.tools!.find(t => t.name === 'gmail_draft_create')!
    expect(tool.description).toContain('gmail_draft_update')
  })

  test('gmail_draft_update description mentions gmail_draft_read', () => {
    const tool = plugin.tools!.find(t => t.name === 'gmail_draft_update')!
    expect(tool.description).toContain('gmail_draft_read')
  })

  test('no tool named gmail_draft (old name)', () => {
    const tool = plugin.tools!.find(t => t.name === 'gmail_draft')
    expect(tool).toBeUndefined()
  })

  test('draft tools accept in_reply_to for threading', () => {
    for (const name of ['gmail_draft_create', 'gmail_draft_update']) {
      const tool = plugin.tools!.find(t => t.name === name)!
      const props = (tool.inputSchema as any).properties
      expect(props.in_reply_to).toBeDefined()
      expect(props.in_reply_to.description).toContain('threading')
    }
  })
})
