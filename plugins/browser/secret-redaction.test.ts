import { describe, test, expect } from 'bun:test'
import { SENSITIVE_NAME_RE, SENSITIVE_AUTOCOMPLETE } from './index.ts'

describe('SENSITIVE_NAME_RE', () => {
  const shouldMatch = [
    'password',
    'user_password',
    'passwd',
    'secret',
    'client_secret',
    'token',
    'session_token',
    'api_key',
    'apikey',
    'api-key',
    'ssn',
    'credit_card',
    'creditcard',
    'credit-card',
    'cvv',
    'cvc',
    'pin',
    'PIN',
    'new_password',
    'current-password',
  ]

  const shouldNotMatch = [
    'email',
    'username',
    'first_name',
    'address',
    'city',
    'phone',
    'search',
    'query',
    'bio',
    'description',
    'url',
    'title',
    'amount',     // financial but not credential
    'opinion',    // contains "pin" but not at word boundary
    'networking', // contains "token" substring? no. just checking.
  ]

  for (const name of shouldMatch) {
    test(`matches "${name}"`, () => {
      expect(SENSITIVE_NAME_RE.test(name.toLowerCase())).toBe(true)
    })
  }

  for (const name of shouldNotMatch) {
    test(`does not match "${name}"`, () => {
      expect(SENSITIVE_NAME_RE.test(name.toLowerCase())).toBe(false)
    })
  }
})

describe('SENSITIVE_AUTOCOMPLETE', () => {
  test('includes credential autocomplete values', () => {
    expect(SENSITIVE_AUTOCOMPLETE.has('cc-number')).toBe(true)
    expect(SENSITIVE_AUTOCOMPLETE.has('cc-csc')).toBe(true)
    expect(SENSITIVE_AUTOCOMPLETE.has('new-password')).toBe(true)
    expect(SENSITIVE_AUTOCOMPLETE.has('current-password')).toBe(true)
  })

  test('does not include non-sensitive values', () => {
    expect(SENSITIVE_AUTOCOMPLETE.has('email')).toBe(false)
    expect(SENSITIVE_AUTOCOMPLETE.has('username')).toBe(false)
    expect(SENSITIVE_AUTOCOMPLETE.has('given-name')).toBe(false)
    expect(SENSITIVE_AUTOCOMPLETE.has('tel')).toBe(false)
  })
})

describe('redaction integration (simulated annotation output)', () => {
  // These test the contract: sensitive fields should show "••••••" not real values
  // in the annotation format used by extractMarkdown.
  // The actual logic runs in-browser via page.evaluate, so we simulate the output format.

  function simulateAnnotation(field: {
    tag: string
    type?: string
    name?: string
    id?: string
    autocomplete?: string
    value?: string
  }): string {
    const parts: string[] = [field.tag]
    if (field.id) parts.push(`id="${field.id}"`)
    if (field.name) parts.push(`name="${field.name}"`)
    if (field.type && field.tag === 'input') parts.push(`type="${field.type}"`)

    if (field.value && field.type !== 'hidden') {
      const nameOrId = ((field.name || '') + ' ' + (field.id || '') + ' ' + (field.autocomplete || '')).toLowerCase()
      const inputType = (field.type || '').toLowerCase()
      const isSensitive =
        inputType === 'password' ||
        SENSITIVE_NAME_RE.test(nameOrId) ||
        SENSITIVE_AUTOCOMPLETE.has(field.autocomplete || '')
      parts.push(`value="${isSensitive ? '••••••' : field.value}"`)
    }

    return `[${parts.join(' ')}]`
  }

  test('password input is redacted', () => {
    const result = simulateAnnotation({
      tag: 'input',
      type: 'password',
      name: 'password',
      value: 'correct-horse-battery-staple',
    })
    expect(result).toContain('value="••••••"')
    expect(result).not.toContain('correct-horse-battery-staple')
  })

  test('password input detected by type alone (even with generic name)', () => {
    const result = simulateAnnotation({
      tag: 'input',
      type: 'password',
      name: 'field1',
      value: 'hunter2',
    })
    expect(result).toContain('value="••••••"')
    expect(result).not.toContain('hunter2')
  })

  test('text input with password-related name is redacted', () => {
    // some sites use type="text" with name="password" (bad practice but real)
    const result = simulateAnnotation({
      tag: 'input',
      type: 'text',
      name: 'api_secret',
      value: 'sk-abc123',
    })
    expect(result).toContain('value="••••••"')
    expect(result).not.toContain('sk-abc123')
  })

  test('text input with cc-number autocomplete is redacted', () => {
    const result = simulateAnnotation({
      tag: 'input',
      type: 'text',
      name: 'cardnumber',
      autocomplete: 'cc-number',
      value: '4111111111111111',
    })
    expect(result).toContain('value="••••••"')
    expect(result).not.toContain('4111111111111111')
  })

  test('regular text input is NOT redacted', () => {
    const result = simulateAnnotation({
      tag: 'input',
      type: 'text',
      name: 'email',
      value: 'user@example.com',
    })
    expect(result).toContain('value="user@example.com"')
  })

  test('textarea is NOT redacted when not sensitive', () => {
    const result = simulateAnnotation({
      tag: 'textarea',
      name: 'bio',
      value: 'I am a normal person.',
    })
    expect(result).toContain('value="I am a normal person."')
  })

  test('hidden input value is omitted entirely', () => {
    const result = simulateAnnotation({
      tag: 'input',
      type: 'hidden',
      name: 'csrf_token',
      value: 'abc123',
    })
    expect(result).not.toContain('value=')
  })

  test('input with cvv name is redacted', () => {
    const result = simulateAnnotation({
      tag: 'input',
      type: 'text',
      name: 'cvv',
      value: '123',
    })
    expect(result).toContain('value="••••••"')
    expect(result).not.toContain('"123"')
  })

  test('input with token in id is redacted', () => {
    const result = simulateAnnotation({
      tag: 'input',
      type: 'text',
      id: 'session_token',
      value: 'tok_abc123xyz',
    })
    expect(result).toContain('value="••••••"')
  })
})
