import { CARD } from '@/lib/agent-types'

/** Fallback viewport dimensions for SSR / non-browser environments */
const SSR_VIEWPORT_W = 800
const SSR_VIEWPORT_H = 600

/**
 * Clamp a popup position so it stays within the viewport.
 */
export function clampPopupPosition(
  position: { x: number; y: number },
  popupWidth: number,
  popupHeight: number,
  offsetY = 20,
): { left: number; top: number } {
  // visualViewport excludes the on-screen keyboard / browser chrome on iOS Safari
  const vv = typeof window !== 'undefined' ? window.visualViewport : null
  const vw = vv?.width ?? (typeof window !== 'undefined' ? window.innerWidth : SSR_VIEWPORT_W)
  const vh = vv?.height ?? (typeof window !== 'undefined' ? window.innerHeight : SSR_VIEWPORT_H)
  const maxX = vw - popupWidth - CARD.margin
  const maxY = vh - popupHeight - CARD.margin

  return {
    left: Math.min(Math.max(CARD.margin, position.x - popupWidth / 2), maxX),
    top: Math.min(Math.max(CARD.margin, position.y + offsetY), maxY),
  }
}
