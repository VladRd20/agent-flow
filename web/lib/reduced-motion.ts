/**
 * `prefers-reduced-motion` support for the canvas-2d renderer.
 *
 * The draw loop calls `prefersReducedMotion()` every frame, so this caches
 * the MediaQueryList and its current value instead of calling
 * `matchMedia` per-frame. `subscribeReducedMotion` wires up the `change`
 * listener once (e.g. in a top-level `useEffect`) so the cached value stays
 * current if the user flips the OS setting while the app is open.
 */

let cachedQuery: MediaQueryList | null = null
let cachedValue = false

function getQuery(): MediaQueryList | null {
  if (typeof window === 'undefined' || !window.matchMedia) return null
  if (!cachedQuery) {
    cachedQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    cachedValue = cachedQuery.matches
  }
  return cachedQuery
}

/** Current `prefers-reduced-motion: reduce` state (false in non-browser environments). */
export function prefersReducedMotion(): boolean {
  getQuery()
  return cachedValue
}

/** Subscribe to OS-level reduced-motion changes. Returns an unsubscribe function. */
export function subscribeReducedMotion(onChange?: () => void): () => void {
  const mql = getQuery()
  if (!mql) return () => {}
  const handler = () => {
    cachedValue = mql.matches
    onChange?.()
  }
  mql.addEventListener('change', handler)
  return () => mql.removeEventListener('change', handler)
}
