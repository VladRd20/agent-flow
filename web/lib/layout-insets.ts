/**
 * Tiny module-level store for chrome that overlays the canvas, so the camera's
 * fit-to-view can leave room for it without prop-drilling through the canvas.
 */
let bottomInsetPx = 0

/** Pixels at the bottom of the viewport covered by chrome (control bar). */
export function setBottomInset(px: number): void {
  bottomInsetPx = Math.max(0, Math.round(px))
}

export function getBottomInset(): number {
  return bottomInsetPx
}
