/**
 * Tiny store for the canvas aspect ratio (width / height), quantised so a
 * resize only notifies when the aspect moves a whole bucket. The All-view grid
 * layout reads it to pick rows/columns; layout is re-synced only on a bucket change.
 */
const STEP = 0.25
let aspect = 1.6
const listeners = new Set<() => void>()

export function getViewAspect(): number {
  return aspect
}

export function setViewAspect(width: number, height: number): void {
  if (!(width > 0) || !(height > 0)) return
  const q = Math.min(3, Math.max(0.25, Math.round((width / height) / STEP) * STEP))
  if (q === aspect) return
  aspect = q
  for (const l of listeners) l()
}

export function onViewAspectChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}
