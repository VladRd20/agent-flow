import { useState, useEffect } from 'react'

/**
 * Mobile/narrow-viewport breakpoint (px). Matches Tailwind's default `md`
 * breakpoint so it reuses the same mental model as the rest of the app.
 * Below this width, components branch into touch-friendly / full-screen
 * layouts instead of the desktop floating-panel layout.
 */
export const MOBILE_BREAKPOINT_PX = 768

/**
 * Reports whether the viewport is at or below the mobile breakpoint.
 * Used to branch component behavior for mobile — never to alter desktop
 * output, which must remain pixel-identical to before this hook existed.
 */
export function useIsMobile(breakpoint: number = MOBILE_BREAKPOINT_PX): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false
    return window.innerWidth <= breakpoint
  })

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`)
    const update = () => setIsMobile(mql.matches)
    update()
    // addEventListener is broadly supported; fall back for older WebViews just in case
    if (mql.addEventListener) {
      mql.addEventListener('change', update)
      return () => mql.removeEventListener('change', update)
    }
    // legacy API fallback
    ;(mql as any).addListener(update)
    // legacy API fallback
    return () => (mql as any).removeListener(update)
  }, [breakpoint])

  return isMobile
}
