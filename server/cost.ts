// Model pricing (per million tokens)
// optimistic = cache read rates, pessimistic = standard input rates

export interface ModelPricing {
  input: number        // $/M tokens
  output: number       // $/M tokens
  cacheRead: number    // $/M tokens
  cacheWrite: number   // $/M tokens
}

// Provider pricing lookup functions — each provider registers its own.
type PricingLookup = (model: string) => ModelPricing | null
const providerLookups: PricingLookup[] = []

/**
 * Register a provider's pricing lookup function.
 * Called once per provider at import time.
 */
export function registerPricingProvider(lookup: PricingLookup): void {
  providerLookups.push(lookup)
}

// Runtime overrides (e.g. from config)
const overrides: Record<string, ModelPricing> = {}

/**
 * Register custom model pricing at runtime (e.g. from config).
 */
export function registerModelPricing(model: string, pricing: ModelPricing): void {
  overrides[model] = pricing
}

function findPricing(model: string): ModelPricing | null {
  // runtime overrides first (exact match, then prefix)
  if (overrides[model]) return overrides[model]
  for (const [key, pricing] of Object.entries(overrides)) {
    if (model.startsWith(key)) return pricing
  }

  // delegate to registered providers
  for (const lookup of providerLookups) {
    const pricing = lookup(model)
    if (pricing) return pricing
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

/**
 * Compute separate input and output costs (optimistic — assumes cache hits).
 */
export function computeInputOutputCost(usage: UsageTotals, model: string): { inputCost: number; outputCost: number } | null {
  const pricing = findPricing(model)
  if (!pricing) return null

  const M = 1_000_000
  const inputCost = (usage.input / M) * pricing.input
    + (usage.cacheRead / M) * pricing.cacheRead
    + (usage.cacheWrite / M) * pricing.cacheWrite
  const outputCost = (usage.output / M) * pricing.output
  return { inputCost, outputCost }
}

export function formatCost(estimate: CostEstimate): string {
  const fmt = (n: number) => `$${n.toFixed(2)}`
  if (Math.abs(estimate.optimistic - estimate.pessimistic) < 0.005) {
    return fmt(estimate.optimistic)
  }
  return `${fmt(estimate.optimistic)}–${fmt(estimate.pessimistic)}`
}
