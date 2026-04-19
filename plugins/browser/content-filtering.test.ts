import { describe, test, expect } from 'bun:test'
import { htmlToMarkdown } from './index.ts'

describe('htmlToMarkdown content filtering', () => {
  test('preserves normal textual content', () => {
    const html = '<h1>Hello World</h1><p>This is a paragraph with <strong>bold</strong> text.</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('Hello World')
    expect(md).toContain('This is a paragraph')
    expect(md).toContain('**bold**')
  })

  test('preserves links with href', () => {
    const html = '<p>Visit <a href="https://example.com">our site</a> for more.</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('[our site](https://example.com)')
  })

  // --- data-URI / blob image stripping ---

  test('strips data-URI images from markdown', () => {
    const html = '<p>Before</p><img src="data:image/png;base64,iVBORAAAAA==" alt="pic"><p>After</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('Before')
    expect(md).toContain('After')
    expect(md).not.toContain('data:image')
    expect(md).not.toContain('iVBOR')
  })

  test('strips blob-URI images from markdown', () => {
    const html = '<img src="blob:https://example.com/abc-123" alt="upload">'
    const md = htmlToMarkdown(html)
    expect(md).not.toContain('blob:')
  })

  // --- inline data-URI / URL-encoded SVG sludge ---

  test('replaces long data-URI strings with [data-uri] placeholder', () => {
    const longData = 'data:image/svg+xml,' + '%3Csvg%20xmlns%3D'.repeat(20)
    const html = `<p>Before ${longData} After</p>`
    const md = htmlToMarkdown(html)
    expect(md).toContain('Before')
    expect(md).toContain('After')
    expect(md).not.toContain('%3Csvg')
    expect(md).toContain('[data-uri]')
  })

  test('strips url()-wrapped data URIs from leaked styles', () => {
    const longPayload = 'A'.repeat(100)
    const html = `<p>Text with url("data:image/png;base64,${longPayload}") leftover</p>`
    const md = htmlToMarkdown(html)
    expect(md).toContain('Text with')
    expect(md).not.toContain(longPayload)
  })

  test('does not mangle short legitimate data references', () => {
    const html = '<p>The data:text format is used for inline content.</p>'
    const md = htmlToMarkdown(html)
    // short data: refs (under 64 chars total) should survive
    expect(md).toContain('data:text')
  })

  // --- SVG elements are stripped at DOM level but test the markdown layer ---

  test('strips inline SVG that somehow survives to markdown', () => {
    // Turndown may render SVG content as text; the data-URI regex catches
    // encoded SVG payloads
    const encodedSvg = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="40"/></svg>'
    )
    const html = `<p>icon: ${encodedSvg}</p>`
    const md = htmlToMarkdown(html)
    expect(md).not.toContain('circle')
    expect(md).toContain('[data-uri]')
  })

  // --- empty list markers / whitespace cleanup ---

  test('removes empty bullet-only lines', () => {
    const html = '<ul><li></li><li></li></ul><p>Real content</p>'
    const md = htmlToMarkdown(html)
    expect(md).toContain('Real content')
    // should not have standalone * lines
    const lines = md.split('\n').map(l => l.trim())
    expect(lines.every(l => l !== '*')).toBe(true)
  })

  test('collapses excessive blank lines', () => {
    const html = '<p>A</p><br><br><br><br><br><p>B</p>'
    const md = htmlToMarkdown(html)
    expect(md).not.toMatch(/\n\n\n/)
  })
})
