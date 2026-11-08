import { useEffect, useRef } from 'react'
import { escapeStack } from '@/lib/escape-layers'

let listening = 0
const onKeyDown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') escapeStack.dispatch(e)
}

/**
 * Registers a layered Escape handler while `enabled`: a press runs only the topmost (most recently
 * enabled) handler. Callback is held in a ref so callers can pass inline functions without resubscribing.
 */
export function useEscapeKey(onEscape: () => void, enabled = true): void {
  const cbRef = useRef(onEscape)
  cbRef.current = onEscape

  useEffect(() => {
    if (!enabled) return
    // Capture phase so layers are resolved before bubble-phase shortcut handlers look at the event
    if (listening++ === 0) window.addEventListener('keydown', onKeyDown, true)
    const pop = escapeStack.push(() => cbRef.current())
    return () => {
      pop()
      if (--listening === 0) window.removeEventListener('keydown', onKeyDown, true)
    }
  }, [enabled])
}
