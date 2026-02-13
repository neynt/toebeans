import { describe, test, expect } from 'bun:test'
import { estimateCost, formatCost, computeInputOutputCost } from './cost.ts'

describe('estimateCost', () => {
  test('returns null for unknown model', () => {
    expect(estimateCost({ input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 }, 'gpt-4o')).toBeNull()
  })

  test('calculates cost for sonnet 4.5', () => {
    // 1M input at $3/M, 1M output at $15/M
    const result = estimateCost(
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      'claude-sonnet-4-5',
    )
    expect(result).not.toBeNull()
    expect(result!.optimistic).toBeCloseTo(18) // $3 + $15
    expect(result!.pessimistic).toBeCloseTo(18) // same, no cache reads
  })

  test('cache reads reduce optimistic cost', () => {
    const result = estimateCost(
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 0 },
      'claude-sonnet-4-5',
    )
    expect(result!.optimistic).toBeCloseTo(0.30) // cache rate: $0.3/M
    expect(result!.pessimistic).toBeCloseTo(3.00) // full input rate: $3/M
  })

  test('prefix-matches dated model IDs', () => {
    const result = estimateCost(
      { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 },
      'claude-opus-4-6-20250901',
    )
    expect(result).not.toBeNull()
    expect(result!.optimistic).toBeCloseTo(15)
  })
})

describe('computeInputOutputCost', () => {
  test('splits cost into input and output components', () => {
    const result = computeInputOutputCost(
      { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 },
      'claude-sonnet-4-5',
    )
    expect(result).not.toBeNull()
    expect(result!.inputCost).toBeCloseTo(3)   // $3/M input
    expect(result!.outputCost).toBeCloseTo(15)  // $15/M output
  })

  test('includes cache costs in inputCost', () => {
    const result = computeInputOutputCost(
      { input: 0, output: 0, cacheRead: 1_000_000, cacheWrite: 1_000_000 },
      'claude-sonnet-4-5',
    )
    expect(result).not.toBeNull()
    expect(result!.inputCost).toBeCloseTo(0.3 + 3.75)  // cacheRead + cacheWrite
    expect(result!.outputCost).toBeCloseTo(0)
  })

  test('returns null for unknown model', () => {
    expect(computeInputOutputCost(
      { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0 },
      'gpt-4o',
    )).toBeNull()
  })
})

describe('formatCost', () => {
  test('shows single value when optimistic ≈ pessimistic', () => {
    expect(formatCost({ optimistic: 1.234, pessimistic: 1.237 })).toBe('$1.23')
  })

  test('shows range when costs differ', () => {
    expect(formatCost({ optimistic: 0.30, pessimistic: 3.00 })).toBe('$0.30–$3.00')
  })
})
