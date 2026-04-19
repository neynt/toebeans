import { describe, test, expect } from 'bun:test'
import createBrowserPlugin from './index.ts'
import { stripEmptyActionFields, normalizeActionType, resolveHeadless } from './index.ts'

const plugin = createBrowserPlugin()
const spawn = plugin.tools!.find(t => t.name === 'browser_spawn')!
const interact = plugin.tools!.find(t => t.name === 'browser_interact')!
const schema = interact.inputSchema as any
const variants: any[] = schema.properties.actions.items.anyOf

describe('browser_interact action schema', () => {
  test('uses anyOf for action items (discriminated union)', () => {
    expect(variants).toBeDefined()
    expect(Array.isArray(variants)).toBe(true)
    expect(variants.length).toBe(26) // one per action type
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
    expect(typeValues).toContain('hover')
    expect(typeValues).toContain('mouse_move')
    expect(typeValues).toContain('mouse_down')
    expect(typeValues).toContain('mouse_up')
    expect(typeValues).toContain('drag')
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
    expect(typeValues).toContain('press_and_hold')
    expect(typeValues).toContain('get_bounds')
    expect(typeValues).toContain('switch_frame')
    expect(typeValues).toContain('list_tabs')
    expect(typeValues).toContain('switch_tab')
    expect(typeValues).toContain('new_tab')
    expect(typeValues).toContain('close_tab')
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

  test('hover variant requires selector', () => {
    const hover = variants.find((v: any) => v.properties.type.const === 'hover')
    expect(Object.keys(hover.properties)).toEqual(['type', 'selector'])
    expect(hover.required).toEqual(['type', 'selector'])
  })

  test('mouse_move variant accepts selector or x/y, optional steps and jitter', () => {
    const mm = variants.find((v: any) => v.properties.type.const === 'mouse_move')
    expect(Object.keys(mm.properties).sort()).toEqual(['jitter', 'selector', 'steps', 'type', 'x', 'y'])
    expect(mm.required).toEqual(['type'])
    expect(mm.properties.steps.type).toBe('integer')
  })

  test('mouse_down variant has optional button', () => {
    const md = variants.find((v: any) => v.properties.type.const === 'mouse_down')
    expect(Object.keys(md.properties).sort()).toEqual(['button', 'type'])
    expect(md.required).toEqual(['type'])
    expect(md.properties.button.enum).toEqual(['left', 'right', 'middle'])
  })

  test('mouse_up variant has optional button', () => {
    const mu = variants.find((v: any) => v.properties.type.const === 'mouse_up')
    expect(Object.keys(mu.properties).sort()).toEqual(['button', 'type'])
    expect(mu.required).toEqual(['type'])
  })

  test('drag variant has source/destination fields', () => {
    const drag = variants.find((v: any) => v.properties.type.const === 'drag')
    expect(Object.keys(drag.properties).sort()).toEqual([
      'hold_ms', 'selector', 'steps', 'to_selector', 'to_x', 'to_y', 'type', 'x', 'y',
    ])
    expect(drag.required).toEqual(['type'])
  })

  test('press_and_hold variant has selector/coords, hold_ms, steps, jitter, button', () => {
    const ph = variants.find((v: any) => v.properties.type.const === 'press_and_hold')
    expect(Object.keys(ph.properties).sort()).toEqual([
      'button', 'hold_ms', 'jitter', 'selector', 'steps', 'type', 'x', 'y',
    ])
    expect(ph.required).toEqual(['type'])
  })

  test('get_bounds variant requires selector', () => {
    const gb = variants.find((v: any) => v.properties.type.const === 'get_bounds')
    expect(Object.keys(gb.properties).sort()).toEqual(['selector', 'type'])
    expect(gb.required).toEqual(['type', 'selector'])
  })

  test('switch_frame variant has optional selector and url', () => {
    const sf = variants.find((v: any) => v.properties.type.const === 'switch_frame')
    expect(Object.keys(sf.properties).sort()).toEqual(['selector', 'type', 'url'])
    expect(sf.required).toEqual(['type'])
  })

  test('list_tabs variant only has type', () => {
    const lt = variants.find((v: any) => v.properties.type.const === 'list_tabs')
    expect(Object.keys(lt.properties)).toEqual(['type'])
    expect(lt.required).toEqual(['type'])
  })

  test('switch_tab variant has optional index and url', () => {
    const st = variants.find((v: any) => v.properties.type.const === 'switch_tab')
    expect(Object.keys(st.properties).sort()).toEqual(['index', 'type', 'url'])
    expect(st.required).toEqual(['type'])
    expect(st.properties.index.type).toBe('integer')
  })

  test('new_tab variant has optional url', () => {
    const nt = variants.find((v: any) => v.properties.type.const === 'new_tab')
    expect(Object.keys(nt.properties).sort()).toEqual(['type', 'url'])
    expect(nt.required).toEqual(['type'])
  })

  test('close_tab variant only has type', () => {
    const ct = variants.find((v: any) => v.properties.type.const === 'close_tab')
    expect(Object.keys(ct.properties)).toEqual(['type'])
    expect(ct.required).toEqual(['type'])
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
      'goto', 'click', 'click_text', 'hover', 'mouse_move', 'mouse_down',
      'mouse_up', 'drag', 'type', 'press', 'wait', 'wait_for',
      'evaluate', 'screenshot', 'scroll', 'select', 'upload_file', 'download',
      'bitwarden_fill', 'press_and_hold', 'get_bounds', 'switch_frame',
      'list_tabs', 'switch_tab', 'new_tab', 'close_tab',
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

  test('maps hover aliases', () => {
    expect(normalizeActionType('mouseover')).toBe('hover')
    expect(normalizeActionType('mouse_hover')).toBe('hover')
  })

  test('maps mouse_move aliases', () => {
    expect(normalizeActionType('move_mouse')).toBe('mouse_move')
    expect(normalizeActionType('moveto')).toBe('mouse_move')
    expect(normalizeActionType('move_to')).toBe('mouse_move')
  })

  test('maps mouse_down/mouse_up aliases', () => {
    expect(normalizeActionType('mousedown')).toBe('mouse_down')
    expect(normalizeActionType('mouseup')).toBe('mouse_up')
  })

  test('maps drag aliases', () => {
    expect(normalizeActionType('drag_and_drop')).toBe('drag')
    expect(normalizeActionType('dragdrop')).toBe('drag')
  })

  test('maps navigation aliases', () => {
    expect(normalizeActionType('navigate')).toBe('goto')
    expect(normalizeActionType('open')).toBe('goto')
  })

  test('maps wait_for aliases', () => {
    expect(normalizeActionType('wait_for_selector')).toBe('wait_for')
  })

  test('maps press_and_hold aliases', () => {
    expect(normalizeActionType('hold')).toBe('press_and_hold')
    expect(normalizeActionType('long_press')).toBe('press_and_hold')
    expect(normalizeActionType('press_hold')).toBe('press_and_hold')
  })

  test('maps get_bounds aliases', () => {
    expect(normalizeActionType('bounds')).toBe('get_bounds')
    expect(normalizeActionType('bounding_box')).toBe('get_bounds')
    expect(normalizeActionType('bbox')).toBe('get_bounds')
  })

  test('maps switch_frame aliases', () => {
    expect(normalizeActionType('frame')).toBe('switch_frame')
    expect(normalizeActionType('iframe')).toBe('switch_frame')
  })

  test('maps switch_tab aliases', () => {
    expect(normalizeActionType('switch_page')).toBe('switch_tab')
    expect(normalizeActionType('tab')).toBe('switch_tab')
  })

  test('maps list_tabs aliases', () => {
    expect(normalizeActionType('tabs')).toBe('list_tabs')
    expect(normalizeActionType('pages')).toBe('list_tabs')
    expect(normalizeActionType('list_pages')).toBe('list_tabs')
  })

  test('maps new_tab aliases', () => {
    expect(normalizeActionType('open_tab')).toBe('new_tab')
    expect(normalizeActionType('new_page')).toBe('new_tab')
  })

  test('maps close_tab aliases', () => {
    expect(normalizeActionType('close_page')).toBe('close_tab')
  })

  test('returns unknown types unchanged (for the switch default to catch)', () => {
    expect(normalizeActionType('totally_bogus')).toBe('totally_bogus')
  })
})

describe('browser_spawn schema', () => {
  const schema = spawn.inputSchema as any

  test('has headful boolean property', () => {
    expect(schema.properties.headful).toBeDefined()
    expect(schema.properties.headful.type).toBe('boolean')
  })

  test('headful is optional (not in required)', () => {
    expect(schema.required ?? []).not.toContain('headful')
  })
})

describe('resolveHeadless', () => {
  test('defaults to true (headless) when no override', () => {
    expect(resolveHeadless(undefined)).toBe(true)
  })

  test('headful: true → headless: false', () => {
    expect(resolveHeadless(true)).toBe(false)
  })

  test('headful: false → headless: true', () => {
    expect(resolveHeadless(false)).toBe(true)
  })
})
