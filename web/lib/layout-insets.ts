/**
 * Tiny module-level store for chrome that overlays the canvas, so the camera's
 * fit-to-view can leave room for it without prop-drilling through the canvas.
 */
import { wakeFrames } from './frame-driver'

let bottomInsetPx = 0
const topInsets = new Map<string, number>()
let topInsetPx = 0

/** Pixels at the bottom of the viewport covered by chrome (control bar). */
export function setBottomInset(px: number): void {
  const v = Math.max(0, Math.round(px))
  if (v === bottomInsetPx) return
  bottomInsetPx = v
  wakeFrames() // fit-to-view must re-run even if the canvas is idle
}

export function getBottomInset(): number {
  return bottomInsetPx
}

/**
 * Pixels at the top of the viewport covered by chrome. Several overlays
 * (top bar, collapsed message pill) each publish under their own key; the
 * inset is the lowest bottom edge among them. Pass 0 to withdraw.
 */
export function setTopInset(key: string, px: number): void {
  const v = Math.max(0, Math.round(px))
  if (v > 0) topInsets.set(key, v)
  else topInsets.delete(key)
  let max = 0
  for (const n of topInsets.values()) if (n > max) max = n
  if (max === topInsetPx) return
  topInsetPx = max
  wakeFrames()
}

export function getTopInset(): number {
  return topInsetPx
}
