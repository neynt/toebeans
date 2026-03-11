import { describe, test, expect } from 'bun:test'
import createBrowserPlugin from './index.ts'
import { stripEmptyActionFields, normalizeActionType } from './index.ts'

const plugin = createBrowserPlugin()
const interact = plugin.tools!.find(t => t.name === 'browser_interact')!
const schema = interact.inputSchema as any
const variants: any[] = schema.properties.actions.items.anyOf

describe('browser_interact action schema', () => {
  test('uses anyOf for action items (discriminated union)', () => {
    expect(variants).toBeDefined()
    expect(Array.isArray(variants)).toBe(true)
    expect(variants.length).toBe(14) // one per action type
  })

  test('every variant has additionalProperties: false', () => {
    for (const variant of variants) {
      expect(variant.additionalProperties).toBe(false)
    }
  })

  test('every variant requires type', () => {
    for (const variant of variants) {
      expect(variant.required).toContain('type')
    }
  })

  test('every variant uses const for type discriminator', () => {
    const typeValues = variants.map((v: any) => v.properties.type.const)
    expect(typeValues).toContain('goto')
    expect(typeValues).toContain('click')
    expect(typeValues).toContain('click_text')
    expect(typeValues).toContain('type')
    expect(typeValues).toContain('press')
    expect(typeValues).toContain('wait')
    expect(typeValues).toContain('wait_for')
    expect(typeValues).toContain('evaluate')
    expect(typeValues).toContain('screenshot')
    expect(typeValues).toContain('scroll')
    expect(typeValues).toContain('select')
    expect(typeValues).toContain('upload_file')
    expect(typeValues).toContain('download')
    expect(typeValues).toContain('bitwarden_fill')
  })

  test('click variant only has type and selector', () => {
    const click = variants.find((v: any) => v.properties.type.const === 'click')
    expect(Object.keys(click.properties)).toEqual(['type', 'selector'])
    expect(click.required).toEqual(['type', 'selector'])
  })

  test('screenshot variant only has type', () => {
    const screenshot = variants.find((v: any) => v.properties.type.const === 'screenshot')
    expect(Object.keys(screenshot.properties)).toEqual(['type'])
  })

  test('scroll variant has optional direction and amount', () => {
    const scroll = variants.find((v: any) => v.properties.type.const === 'scroll')
    expect(Object.keys(scroll.properties).sort()).toEqual(['amount', 'direction', 'type'])
    expect(scroll.required).toEqual(['type'])
  })

  test('bitwarden_fill has all credential fields', () => {
    const bw = variants.find((v: any) => v.properties.type.const === 'bitwarden_fill')
    expect(Object.keys(bw.properties).sort()).toEqual([
      'password_selector', 'search', 'session_token', 'submit_selector', 'type', 'username_selector',
    ])
    expect(bw.required).toContain('session_token')
    expect(bw.required).toContain('search')
    expect(bw.required).not.toContain('submit_selector')
  })
})

describe('stripEmptyActionFields', () => {
  test('strips empty strings', () => {
    const result = stripEmptyActionFields({
      type: 'click',
      selector: '#btn',
      url: '',
      text: '',
      key: '',
    })
    expect(result).toEqual({ type: 'click', selector: '#btn' })
  })

  test('strips zero values', () => {
    const result = stripEmptyActionFields({
      type: 'click',
      selector: '#btn',
      ms: 0,
      amount: 0,
    })
    expect(result).toEqual({ type: 'click', selector: '#btn' })
  })

  test('preserves non-zero numbers', () => {
    const result = stripEmptyActionFields({
      type: 'wait',
      ms: 1500,
    })
    expect(result).toEqual({ type: 'wait', ms: 1500 })
  })

  test('strips empty arrays (except file_paths)', () => {
    const result = stripEmptyActionFields({
      type: 'click',
      selector: '#btn',
      file_paths: [],
    })
    // file_paths: [] is intentional (means "clear input")
    expect(result).toEqual({ type: 'click', selector: '#btn', file_paths: [] })
  })

  test('preserves non-empty values', () => {
    const result = stripEmptyActionFields({
      type: 'type',
      selector: '#input',
      text: 'hello world',
      ms: 5000,
    })
    expect(result).toEqual({
      type: 'type',
      selector: '#input',
      text: 'hello world',
      ms: 5000,
    })
  })

  test('handles a fully-bloated action from the LLM', () => {
    // this is what the model actually emits with the old flat schema
    const bloated = {
      type: 'click',
      url: '',
      selector: '#temp_basis_shown-A',
      text: '',
      key: '',
      ms: 0,
      js: '',
      value: '',
      direction: 'down',
      amount: 500,
      download_path: '',
      file_paths: [],
      session_token: '',
      search: '',
      username_selector: '',
      password_selector: '',
      submit_selector: '',
    }
    const result = stripEmptyActionFields(bloated)
    // direction/amount are non-empty so they survive, file_paths: [] is preserved
    // intentionally (it means "clear input" for upload_file). everything else is gone.
    expect(result).toEqual({
      type: 'click',
      selector: '#temp_basis_shown-A',
      direction: 'down',
      amount: 500,
      file_paths: [],
    })
  })

  test('preserves non-empty file_paths', () => {
    const result = stripEmptyActionFields({
      type: 'upload_file',
      selector: '#f',
      file_paths: ['/tmp/test.txt'],
    })
    expect(result).toEqual({
      type: 'upload_file',
      selector: '#f',
      file_paths: ['/tmp/test.txt'],
    })
  })
})

describe('normalizeActionType', () => {
  test('passes through canonical action types unchanged', () => {
    const canonical = [
      'goto', 'click', 'click_text', 'type', 'press', 'wait', 'wait_for',
      'evaluate', 'screenshot', 'scroll', 'select', 'upload_file', 'download',
      'bitwarden_fill',
    ]
    for (const type of canonical) {
      expect(normalizeActionType(type)).toBe(type)
    }
  })

  test('maps bitwarden_fill aliases', () => {
    expect(normalizeActionType('fill_credentials')).toBe('bitwarden_fill')
    expect(normalizeActionType('credential_fill')).toBe('bitwarden_fill')
    expect(normalizeActionType('credentials')).toBe('bitwarden_fill')
    expect(normalizeActionType('bitwarden')).toBe('bitwarden_fill')
    expect(normalizeActionType('fill_password')).toBe('bitwarden_fill')
    expect(normalizeActionType('autofill')).toBe('bitwarden_fill')
  })

  test('maps click_text aliases', () => {
    expect(normalizeActionType('click_by_text')).toBe('click_text')
    expect(normalizeActionType('text_click')).toBe('click_text')
  })

  test('maps type aliases', () => {
    expect(normalizeActionType('fill')).toBe('type')
    expect(normalizeActionType('input')).toBe('type')
  })

  test('maps evaluate aliases', () => {
    expect(normalizeActionType('eval')).toBe('evaluate')
    expect(normalizeActionType('run_js')).toBe('evaluate')
    expect(normalizeActionType('javascript')).toBe('evaluate')
  })

  test('maps navigation aliases', () => {
    expect(normalizeActionType('navigate')).toBe('goto')
    expect(normalizeActionType('open')).toBe('goto')
  })

  test('maps wait_for aliases', () => {
    expect(normalizeActionType('wait_for_selector')).toBe('wait_for')
  })

  test('returns unknown types unchanged (for the switch default to catch)', () => {
    expect(normalizeActionType('totally_bogus')).toBe('totally_bogus')
  })
})
