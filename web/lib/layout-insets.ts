/**
 * Tiny module-level store for chrome that overlays the canvas, so the camera's
 * fit-to-view can leave room for it without prop-drilling through the canvas.
 */
import { wakeFrames } from './frame-driver'

let bottomInsetPx = 0
const topInsets = new Map<string, number>()
let topInsetPx = 0
const rightInsets = new Map<string, number>()
let rightInsetPx = 0
const leftInsets = new Map<string, number>()
let leftInsetPx = 0

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

/** Top inset; `excludeKey` omits one publisher (so an overlay can position itself below the others). */
export function getTopInset(excludeKey?: string): number {
  if (excludeKey === undefined || !topInsets.has(excludeKey)) return topInsetPx
  let max = 0
  for (const [k, n] of topInsets) if (k !== excludeKey && n > max) max = n
  return max
}

/**
 * Pixels at the right of the viewport covered by chrome (wide-layout cost
 * card). Keyed like top insets; the inset is the widest among publishers.
 */
export function setRightInset(key: string, px: number): void {
  const v = Math.max(0, Math.round(px))
  if (v > 0) rightInsets.set(key, v)
  else rightInsets.delete(key)
  let max = 0
  for (const n of rightInsets.values()) if (n > max) max = n
  if (max === rightInsetPx) return
  rightInsetPx = max
  wakeFrames()
}

export function getRightInset(): number {
  return rightInsetPx
}

/**
 * Pixels at the left of the viewport covered by floating chrome (phone view-control
 * buttons). Keyed like the others; the inset is the widest among publishers.
 */
export function setLeftInset(key: string, px: number): void {
  const v = Math.max(0, Math.round(px))
  if (v > 0) leftInsets.set(key, v)
  else leftInsets.delete(key)
  let max = 0
  for (const n of leftInsets.values()) if (n > max) max = n
  if (max === leftInsetPx) return
  leftInsetPx = max
  wakeFrames()
}

export function getLeftInset(): number {
  return leftInsetPx
}
