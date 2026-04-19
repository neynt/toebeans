import { describe, test, expect } from 'bun:test'
import { getModelPricing } from './moonshot.ts'

describe('moonshot getModelPricing', () => {
  test('returns pricing for kimi-k2.5', () => {
    const pricing = getModelPricing('kimi-k2.5')
    expect(pricing).not.toBeNull()
    expect(pricing!.input).toBe(2)
    expect(pricing!.output).toBe(8)
    expect(pricing!.cacheRead).toBe(0.2)
  })

  test('returns null for non-moonshot models', () => {
    expect(getModelPricing('claude-sonnet-4-5')).toBeNull()
    expect(getModelPricing('gpt-4o')).toBeNull()
  })
})
