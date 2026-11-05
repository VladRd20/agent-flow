import { useEffect } from 'react'
import { setTopInset } from '@/lib/layout-insets'

/** Gap kept between top chrome and the fitted graph. */
const GAP = 8

/**
 * Publishes the bottom edge of a top-anchored overlay as a top inset, so
 * fit-to-view keeps nodes out from under it. Re-measured on element resize
 * and window resize only — never per frame.
 */
export function useTopChromeInset(key: string, ref: React.RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const el = ref.current
    if (!el || !active) { setTopInset(key, 0); return }
    const publish = () => {
      const r = el.getBoundingClientRect()
      setTopInset(key, r.height > 0 ? r.bottom + GAP : 0)
    }
    publish()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null
    ro?.observe(el)
    window.addEventListener('resize', publish)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', publish)
      setTopInset(key, 0)
    }
  }, [key, ref, active])
}
