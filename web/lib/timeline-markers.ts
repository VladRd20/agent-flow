/** Time-axis marker spacing and labels for the execution timeline. */

const MARKER_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200]

/** Smallest "nice" interval (seconds) whose labels stay at least `minGapPx` apart. */
export function pickMarkerInterval(timeSpan: number, barWidth: number, minGapPx: number): number {
  if (!(timeSpan > 0) || !(barWidth > 0)) return MARKER_STEPS[MARKER_STEPS.length - 1]
  for (const step of MARKER_STEPS) {
    if ((step / timeSpan) * barWidth >= minGapPx) return step
  }
  // Beyond the table (very long sessions): whole hours
  const perLabel = timeSpan / Math.max(1, Math.floor(barWidth / minGapPx))
  return Math.ceil(perLabel / 3600) * 3600
}

/** 45 → "45s", 90 → "1:30", 600 → "10m", 3720 → "1h02" */
export function formatMarker(t: number): string {
  const s = Math.round(t)
  if (s < 60) return `${s}s`
  if (s < 3600) return s % 60 === 0 ? `${s / 60}m` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
  const m = Math.floor(s / 60)
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}
