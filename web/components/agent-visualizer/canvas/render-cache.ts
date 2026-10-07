// ─── Glow sprite cache ─────────────────────────────────────────────────────
// Pre-renders radial gradient glows to off-screen canvases.
// Avoids creating CanvasGradient objects every frame.

const glowSpriteCache = new Map<string, HTMLCanvasElement>()
// Defensive cap, matching textWidthCache below. Growth is normally bounded
// per agent/color/alpha/radius combination (radius is quantized to an
// integer pixel before being used as part of the key), but a very long-
// running or high-churn session can still accumulate many distinct
// combinations over time, and each entry is an offscreen canvas.
const GLOW_SPRITE_CACHE_MAX = 500

/** Simple radial glow: gradient from center (innerAlpha) to edge (outerAlpha) */
export function getGlowSprite(
  color: string, radius: number, innerAlpha: string, outerAlpha: string,
): HTMLCanvasElement {
  const rQ = Math.ceil(radius)
  const key = `${color}|${rQ}|${innerAlpha}|${outerAlpha}`
  let sprite = glowSpriteCache.get(key)
  if (sprite) return sprite

  const size = rQ * 2
  sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  const ctx = sprite.getContext('2d')!
  const glow = ctx.createRadialGradient(rQ, rQ, 0, rQ, rQ, rQ)
  glow.addColorStop(0, color + innerAlpha)
  glow.addColorStop(1, color + outerAlpha)
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  if (glowSpriteCache.size > GLOW_SPRITE_CACHE_MAX) glowSpriteCache.clear()
  glowSpriteCache.set(key, sprite)
  return sprite
}

/** Agent glow: gradient from innerRadius to outerRadius */
export function getAgentGlowSprite(
  color: string, innerRadius: number, outerRadius: number, glowAlphaHex: string,
): HTMLCanvasElement {
  const iR = Math.round(innerRadius)
  const oR = Math.ceil(outerRadius)
  const key = `ag|${color}|${iR}|${oR}|${glowAlphaHex}`
  let sprite = glowSpriteCache.get(key)
  if (sprite) return sprite

  const size = oR * 2
  sprite = document.createElement('canvas')
  sprite.width = size
  sprite.height = size
  const ctx = sprite.getContext('2d')!
  const glow = ctx.createRadialGradient(oR, oR, iR, oR, oR, oR)
  glow.addColorStop(0, color + glowAlphaHex)
  glow.addColorStop(1, color + '00')
  ctx.fillStyle = glow
  ctx.fillRect(0, 0, size, size)

  if (glowSpriteCache.size > GLOW_SPRITE_CACHE_MAX) glowSpriteCache.clear()
  glowSpriteCache.set(key, sprite)
  return sprite
}

// ─── Text measurement cache ────────────────────────────────────────────────
// Caches ctx.measureText().width to avoid redundant browser layout per frame.

const textWidthCache = new Map<string, number>()
const TEXT_CACHE_MAX = 2000

export function measureTextCached(ctx: CanvasRenderingContext2D, text: string): number {
  const key = ctx.font + '|' + text
  let w = textWidthCache.get(key)
  if (w !== undefined) return w
  w = ctx.measureText(text).width
  if (textWidthCache.size > TEXT_CACHE_MAX) textWidthCache.clear()
  textWidthCache.set(key, w)
  return w
}
