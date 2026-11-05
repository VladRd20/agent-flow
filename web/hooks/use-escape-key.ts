import { useEffect, useRef } from 'react'

/**
 * Calls `onEscape` when Escape is pressed while `enabled`. Callback is held in a
 * ref so callers can pass inline functions without resubscribing.
 */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  const cbRef = useRef(onEscape)
  cbRef.current = onEscape

  useEffect(() => {
    if (!enabled) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cbRef.current()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enabled])
}
