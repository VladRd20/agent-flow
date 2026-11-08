/** Compact token count: 842, 12.4k, 1.8M. */
export function formatCompactTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0'
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(tokens >= 100_000 ? 0 : 1)}k`
  return String(Math.round(tokens))
}

/** Dollar amount used by the cost chip and card: sub-cent amounts keep 4 places. */
export function formatCostUsd(cost: number): string {
  if (!(cost > 0)) return '$0.000'
  return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(3)}`
}

/** Text of the always-visible session cost chip, e.g. "$0.412 · 1.8M tok". */
export function formatCostChip(cost: number, tokens: number): string {
  return `${formatCostUsd(cost)} · ${formatCompactTokens(tokens)} tok`
}

/** Plain-language summary for the chip's accessible name and the visually-hidden mirror. */
/** Tooltip for every cost total: the figure is cumulative and monotonic. */
export const COST_TOTAL_TOOLTIP = 'Total spent this session; never decreases'

export function costSummarySentence(cost: number, tokens: number): string {
  return `Total session cost about ${formatCostUsd(cost)}, ${formatCompactTokens(tokens)} tokens`
}
