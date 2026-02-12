// Anthropic model pricing (per million tokens)
// optimistic = cache read rates, pessimistic = standard input rates

interface ModelPricing {
  input: number        // $/M tokens
  output: number       // $/M tokens
  cacheRead: number    // $/M tokens
  cacheWrite: number   // $/M tokens
}

const PRICING: Record<string, ModelPricing> = {
  // Claude 4.5 / 4.6 family
  'claude-opus-4-6':     { input: 15,  output: 75,  cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-5':   { input: 3,   output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5':    { input: 0.8, output: 4,   cacheRead: 0.08, cacheWrite: 1.0 },
  // Claude 3.5
  'claude-3-5-sonnet':   { input: 3,   output: 15,  cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-3-5-haiku':    { input: 0.8, output: 4,   cacheRead: 0.08, cacheWrite: 1.0 },
}

function findPricing(model: string): ModelPricing | null {
  // exact match first
  if (PRICING[model]) return PRICING[model]
  // prefix match (e.g. "claude-opus-4-6-20250901" -> "claude-opus-4-6")
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return pricing
  }
  return null
}

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface CostEstimate {
  optimistic: number   // best case (max cache hits)
  pessimistic: number  // worst case (no cache hits)
}

/**
 * Estimate cost from actual API usage tokens.
 * Optimistic: uses cache read rate for cacheRead tokens.
 * Pessimistic: treats cacheRead tokens as regular input.
 */
export function estimateCost(usage: UsageTotals, model: string): CostEstimate | null {
  const pricing = findPricing(model)
  if (!pricing) return null

  const M = 1_000_000

  // both estimates share output and cacheWrite costs
  const outputCost = (usage.output / M) * pricing.output
  const cacheWriteCost = (usage.cacheWrite / M) * pricing.cacheWrite

  // optimistic: cache reads at cache rate
  const optimistic = (usage.input / M) * pricing.input
    + (usage.cacheRead / M) * pricing.cacheRead
    + outputCost + cacheWriteCost

  // pessimistic: cache reads counted as full-price input
  const pessimistic = ((usage.input + usage.cacheRead) / M) * pricing.input
    + outputCost + cacheWriteCost

  return { optimistic, pessimistic }
}

export function formatCost(estimate: CostEstimate): string {
  const fmt = (n: number) => `$${n.toFixed(2)}`
  if (Math.abs(estimate.optimistic - estimate.pessimistic) < 0.005) {
    return fmt(estimate.optimistic)
  }
  return `${fmt(estimate.optimistic)}–${fmt(estimate.pessimistic)}`
}
