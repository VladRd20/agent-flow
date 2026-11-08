/**
 * Screen-space rectangle helpers for overlay declutter (labels, bubbles, tool
 * cards). Pure and DOM-free so they can be unit tested.
 */

export interface Rect { x: number; y: number; w: number; h: number }

export function rectsOverlap(a: Rect, b: Rect, pad = 0): boolean {
  return a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y
}

export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/** Shift a rect so it lies inside the viewport (never resizes it). */
export function clampRectToViewport(r: Rect, vw: number, vh: number, margin: number, top = 0): Rect {
  const minY = Math.max(margin, top)
  const maxX = Math.max(margin, vw - margin - r.w)
  const maxY = Math.max(minY, vh - margin - r.h)
  return { x: Math.min(Math.max(margin, r.x), maxX), y: Math.min(Math.max(minY, r.y), maxY), w: r.w, h: r.h }
}

export function intersectsViewport(r: Rect, vw: number, vh: number, slack = 0): boolean {
  return r.x + r.w > -slack && r.y + r.h > -slack && r.x < vw + slack && r.y < vh + slack
}

export function insideViewport(r: Rect, vw: number, vh: number, margin = 0): boolean {
  return r.x >= margin && r.y >= margin && r.x + r.w <= vw - margin && r.y + r.h <= vh - margin
}

/** Ordered set of already-placed rects. Entries can carry an owner id that callers may ignore. */
export class PlacedRects {
  private items: Array<{ rect: Rect; owner?: string }> = []

  add(rect: Rect, owner?: string): void {
    this.items.push({ rect, owner })
  }

  collides(rect: Rect, pad = 0, ignoreOwner?: string): boolean {
    for (const it of this.items) {
      if (ignoreOwner !== undefined && it.owner === ignoreOwner) continue
      if (rectsOverlap(rect, it.rect, pad)) return true
    }
    return false
  }

  totalOverlap(rect: Rect, ignoreOwner?: string): number {
    let sum = 0
    for (const it of this.items) {
      if (ignoreOwner !== undefined && it.owner === ignoreOwner) continue
      sum += overlapArea(rect, it.rect)
    }
    return sum
  }

  get size(): number { return this.items.length }
}

export interface PlaceResult { rect: Rect; index: number; clean: boolean }

/**
 * Pick the first candidate (clamped into the viewport) that is free of
 * collisions. If every candidate collides, the one with the least overlap is
 * returned with clean = false so callers can hide or force-draw it.
 */
export function placeBest(
  candidates: Rect[], placed: PlacedRects, vw: number, vh: number,
  margin: number, pad: number, ignoreOwner?: string, top = 0,
): PlaceResult | null {
  let best: PlaceResult | null = null
  let bestOverlap = Infinity
  for (let i = 0; i < candidates.length; i++) {
    const clamped = clampRectToViewport(candidates[i], vw, vh, margin, top)
    if (!placed.collides(clamped, pad, ignoreOwner)) return { rect: clamped, index: i, clean: true }
    const o = placed.totalOverlap(clamped, ignoreOwner)
    if (o < bestOverlap) { bestOverlap = o; best = { rect: clamped, index: i, clean: false } }
  }
  return best
}
