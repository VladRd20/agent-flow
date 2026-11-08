import { useEffect } from 'react'
import { setKeepOut } from '@/lib/layout-insets'

const KEY_PREFIX = 'sheet-'
const SETTLE_MS = 360 // SlidingPanel transition is 300ms: re-measure once it has landed

/**
 * On phones the agent / chat / files / transcript / timeline sheets cover part of the canvas.
 * Publish each open sheet's rect to the overlay keep-out store so message bubbles and tool cards
 * route around them instead of sitting cut under a sheet edge.
 */
export function useSheetKeepOuts(enabled: boolean): void {
  useEffect(() => {
    if (!enabled || typeof document === 'undefined') return
    let published = 0
    let raf = 0
    let settle: ReturnType<typeof setTimeout> | undefined

    const measure = () => {
      raf = 0
      let n = 0
      document.querySelectorAll<HTMLElement>('.af-sheet').forEach((el) => {
        if (el.closest('[aria-hidden="true"]')) return // closed sliding panel
        const r = el.getBoundingClientRect()
        if (r.width <= 0 || r.height <= 0) return
        setKeepOut(KEY_PREFIX + n, { x: r.left, y: r.top, w: r.width, h: r.height })
        n++
      })
      for (let i = n; i < published; i++) setKeepOut(KEY_PREFIX + i, null)
      published = n
    }
    const schedule = () => {
      if (!raf) raf = requestAnimationFrame(measure)
      clearTimeout(settle)
      settle = setTimeout(measure, SETTLE_MS)
    }

    schedule()
    const mo = new MutationObserver(schedule)
    mo.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-hidden'] })
    window.addEventListener('resize', schedule)
    return () => {
      mo.disconnect()
      window.removeEventListener('resize', schedule)
      if (raf) cancelAnimationFrame(raf)
      clearTimeout(settle)
      for (let i = 0; i < published; i++) setKeepOut(KEY_PREFIX + i, null)
    }
  }, [enabled])
}
