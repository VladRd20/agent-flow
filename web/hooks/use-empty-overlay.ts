"use client"

import { useEffect, useState } from 'react'
import { EMPTY_OVERLAY_GRACE_MS, shouldShowEmptyOverlay } from '@/lib/empty-overlay'

/**
 * True once the canvas has been empty for the grace period. `resetKey` (the selected session)
 * restarts the clock, so switching tabs never shows the overlay for the transient empty frames.
 */
export function useEmptyOverlayVisible(isEmpty: boolean, resetKey: string | null, graceMs = EMPTY_OVERLAY_GRACE_MS): boolean {
  const [elapsedKey, setElapsedKey] = useState<string | null | undefined>(undefined)
  useEffect(() => {
    if (!isEmpty) { setElapsedKey(undefined); return }
    const id = setTimeout(() => setElapsedKey(resetKey), graceMs)
    return () => clearTimeout(id)
  }, [isEmpty, resetKey, graceMs])
  // The elapsed flag only counts for the key it was set for: a stale one from another tab is ignored
  return shouldShowEmptyOverlay(isEmpty, elapsedKey !== undefined && elapsedKey === resetKey ? graceMs : 0, graceMs)
}
