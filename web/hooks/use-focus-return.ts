import { useEffect, useRef } from 'react'

/** Minimal element shape so the decision is testable without a DOM. */
export interface FocusLike {
  isConnected?: boolean
  focus?: (opts?: { preventScroll?: boolean }) => void
  closest?: (selector: string) => unknown
  tagName?: string
}

/** Focus should go back to the trigger when focus was dropped by the closing sheet:
 *  nothing focused, focus on <body>, on a removed element, or inside a now aria-hidden subtree. */
export function shouldRestoreFocus(active: FocusLike | null, trigger: FocusLike | null): boolean {
  if (!trigger || trigger.isConnected === false || typeof trigger.focus !== 'function') return false
  if (!active || active.tagName === 'BODY') return true
  if (active.isConnected === false) return true
  return !!active.closest?.('[aria-hidden="true"]')
}

/**
 * Remembers which element had focus when a sheet opened and puts focus back there when it closes
 * (or unmounts), unless the user already moved focus somewhere meaningful.
 */
export function useFocusReturn(open: boolean): void {
  const triggerRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    if (!open) return
    const a = document.activeElement
    triggerRef.current = a instanceof HTMLElement && a !== document.body ? a : null
    return () => {
      const trigger = triggerRef.current
      triggerRef.current = null
      // Wait a frame: the closing sheet is hidden/removed by then, so activeElement reflects reality
      requestAnimationFrame(() => {
        if (shouldRestoreFocus(document.activeElement as HTMLElement | null, trigger)) {
          trigger?.focus({ preventScroll: true })
        }
      })
    }
  }, [open])
}
