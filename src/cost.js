// Per-run cost estimator. Every run silently spends money — SalesQL credits, Apollo credits,
// Anthropic tokens. This turns those counts into an honest dollar estimate so spend is never invisible.
//
// These are ESTIMATES with configurable unit prices (real prices vary by plan). The point is a
// truthful order-of-magnitude ("~$4.20"), not accounting-grade billing.

// Default unit prices (USD). Override per-deployment via cost settings if desired.
export const DEFAULT_PRICES = {
  apolloPerDiscovered: 0.02, // Apollo credit per person surfaced (plan-dependent; free tiers ≈ 0)
  salesqlPerLookup: 0.04, // SalesQL credit per enrichment attempt (charged per lookup, hit or miss)
  anthropicPerScore: 0.017, // ~1 Opus call/candidate ≈ 1.5k in + 0.4k out at Opus 4.8 rates
};

const round = (n) => Math.round(n * 100) / 100;

/**
 * @param {object} summary  a pipeline or poolPipeline summary
 * @param {object} [prices] unit-price overrides (see DEFAULT_PRICES)
 * @returns {{apollo:number, salesql:number, anthropic:number, total:number, lines:Array}}
 */
export function estimateCost(summary = {}, prices = {}) {
  const p = { ...DEFAULT_PRICES, ...prices };

  // SalesQL is charged per enrichment ATTEMPT, i.e. once per discovered candidate — not per email found.
  const lookups = summary.discovered ?? summary.enriched ?? 0;
  // AI scoring runs once per candidate that reached matching (pool runs only, and only when a key is set).
  const scored = summary.aiUsed ? (summary.enriched ?? 0) : 0;

  const apollo = round((summary.discovered || 0) * p.apolloPerDiscovered);
  const salesql = round(lookups * p.salesqlPerLookup);
  const anthropic = round(scored * p.anthropicPerScore);
  const total = round(apollo + salesql + anthropic);

  return {
    apollo,
    salesql,
    anthropic,
    total,
    lines: [
      { service: 'Apollo', detail: `${summary.discovered || 0} discovered`, cost: apollo },
      { service: 'SalesQL', detail: `${lookups} lookups`, cost: salesql },
      { service: 'Anthropic', detail: scored ? `${scored} AI scores` : 'AI off', cost: anthropic },
    ],
  };
}
