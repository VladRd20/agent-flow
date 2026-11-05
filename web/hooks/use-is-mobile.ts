import { useState, useEffect } from 'react'

/**
 * Mobile/narrow-viewport breakpoint (px). Matches Tailwind's default `md`
 * breakpoint so it reuses the same mental model as the rest of the app.
 * Below this width, components branch into touch-friendly / full-screen
 * layouts instead of the desktop floating-panel layout.
 */
export const MOBILE_BREAKPOINT_PX = 768

/**
 * Landscape phones are wider than the breakpoint but very short; a coarse
 * pointer plus a short viewport is treated as mobile too. Keep in sync with the
 * mobile @media block in app/globals.css.
 */
export const MOBILE_QUERY = `(max-width: ${MOBILE_BREAKPOINT_PX}px), (pointer: coarse) and (max-height: 500px)`

function useMediaQuery(query: string, fallback: boolean): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return fallback
    return window.matchMedia(query).matches
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(query)
    const update = () => setMatches(mql.matches)
    update()
    if (mql.addEventListener) {
      mql.addEventListener('change', update)
      return () => mql.removeEventListener('change', update)
    }
    // legacy API fallback for older WebViews
    ;(mql as any).addListener(update)
    return () => (mql as any).removeListener(update)
  }, [query])

  return matches
}

/**
 * Reports whether the viewport should use the mobile layout.
 * Used to branch component behavior for mobile — never to alter desktop output.
 */
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT_PX): boolean {
  const query = breakpoint === MOBILE_BREAKPOINT_PX
    ? MOBILE_QUERY
    : `(max-width: ${breakpoint}px), (pointer: coarse) and (max-height: 500px)`
  return useMediaQuery(query, false)
}

/** True when the primary input is touch (fingers need bigger targets, no hover). */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery('(pointer: coarse)', false)
}
