/**
 * Pure helpers for the context-usage meters (bar under a node, ring around the
 * main node). Tokens can legitimately exceed tokensMax briefly (or with a
 * wrong model window), so everything here clamps instead of trusting ratios.
 */

export interface MeterSegment { value: number; color: string }

export const FULL_TURN = Math.PI * 2

/** usage ratio, safe against 0/NaN/negative tokensMax. */
export function usageRatio(total: number, max: number): number {
  if (!(total > 0)) return 0
  if (!(max > 0)) return 1
  return total / max
}

export function clamp01(n: number): number {
  return Number.isFinite(n) ? (n < 0 ? 0 : n > 1 ? 1 : n) : 0
}

/** "62%" ; values past 999% collapse to ">999%". */
export function formatUsagePercent(ratio: number): string {
  if (!Number.isFinite(ratio) || ratio <= 0) return '0%'
  const pct = Math.round(ratio * 100)
  return pct > 999 ? '>999%' : `${pct}%`
}

export interface BarSegment { color: string; start: number; end: number }
export interface BarLayout {
  /** 0..1 fraction of the bar that is filled */
  fill: number
  /** true when usage exceeds capacity */
  over: boolean
  /** segments as fractions of the full bar width, always within [0, fill] */
  segments: BarSegment[]
}

/**
 * Lay segments out along a bar of unit width. The fill is clamped to 1 and the
 * segments are scaled proportionally to the *filled* width (so they can never
 * run past the end of the bar, even when the breakdown sums to more than the
 * total or the total exceeds the window).
 */
export function layoutContextBar(segs: MeterSegment[], total: number, max: number): BarLayout {
  const ratio = usageRatio(total, max)
  const fill = clamp01(ratio)
  const over = ratio > 1
  const positive = segs.filter(s => s.value > 0)
  const sum = positive.reduce((a, s) => a + s.value, 0)
  const segments: BarSegment[] = []
  if (fill <= 0 || sum <= 0) return { fill, over, segments }
  // If the breakdown under-reports the total, keep its true share of the
  // filled width rather than stretching it to look complete.
  const denom = Math.max(sum, total)
  let cursor = 0
  for (const s of positive) {
    const w = (s.value / denom) * fill
    segments.push({ color: s.color, start: cursor, end: Math.min(fill, cursor + w) })
    cursor += w
  }
  return { fill, over, segments }
}

export interface RingArc { color: string; start: number; end: number }

/**
 * Ring arcs (radians, starting at 12 o'clock). Cumulative sweep is clamped to
 * one full turn; past capacity the ring is a solid, proportionally scaled loop.
 */
export function layoutContextRing(segs: MeterSegment[], total: number, max: number, startAngle = -Math.PI / 2): RingArc[] {
  const positive = segs.filter(s => s.value > 0)
  const sum = positive.reduce((a, s) => a + s.value, 0)
  if (sum <= 0 || !(max > 0)) return []
  const denom = Math.max(max, sum, total)
  const arcs: RingArc[] = []
  let angle = startAngle
  const limit = startAngle + FULL_TURN
  for (const s of positive) {
    const sweep = (s.value / denom) * FULL_TURN
    const end = Math.min(limit, angle + sweep)
    if (end > angle) arcs.push({ color: s.color, start: angle, end })
    angle = end
  }
  return arcs
}
