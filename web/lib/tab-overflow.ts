/**
 * Overflow decision for the session tab strip, with hysteresis.
 *
 * `contentWidth` must be the width of the tabs themselves (never including the
 * "Next running" chip), otherwise the chip changes the measurement that decides
 * whether the chip is shown and the strip flickers.
 */
export const OVERFLOW_ON_PX = 2
export const OVERFLOW_OFF_PX = -4

export function decideOverflow(prev: boolean, contentWidth: number, viewWidth: number): boolean {
  const diff = contentWidth - viewWidth
  if (diff > OVERFLOW_ON_PX) return true
  if (diff <= OVERFLOW_OFF_PX) return false
  return prev
}

/** Edge-fade variant for the strip; `none` unless the tabs overflow. */
export type TabFade = 'none' | 'end' | 'start' | 'both'
export function decideFade(overflowing: boolean, scrollLeft: number, clientWidth: number, scrollWidth: number): TabFade {
  if (!overflowing) return 'none'
  const atStart = scrollLeft <= 2
  const atEnd = scrollLeft + clientWidth >= scrollWidth - 2
  return atStart ? 'end' : atEnd ? 'start' : 'both'
}
