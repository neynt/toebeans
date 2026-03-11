import { describe, test, expect } from 'bun:test'
import { getModelPricing } from './anthropic.ts'

describe('anthropic getModelPricing', () => {
  test('returns pricing for known models', () => {
    const opus = getModelPricing('claude-opus-4-6')
    expect(opus).not.toBeNull()
    expect(opus!.input).toBe(15)
    expect(opus!.output).toBe(75)

    const sonnet = getModelPricing('claude-sonnet-4-5')
    expect(sonnet).not.toBeNull()
    expect(sonnet!.input).toBe(3)
  })

  test('prefix-matches dated model IDs', () => {
    const result = getModelPricing('claude-opus-4-6-20250901')
    expect(result).not.toBeNull()
    expect(result!.input).toBe(15)
  })

  test('returns null for non-anthropic models', () => {
    expect(getModelPricing('gpt-4o')).toBeNull()
    expect(getModelPricing('kimi-k2.5')).toBeNull()
  })
})
