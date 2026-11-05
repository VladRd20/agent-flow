/**
 * Bloom post-processing for holographic glow effect.
 * Takes the main canvas, extracts bright areas, blurs them,
 * and composites back with additive blending.
 */

/** True if this browser's 2D context actually applies ctx.filter (Safari has
 *  historically accepted the property but ignored it, so a read-back is not a
 *  reliable test — render a pixel through `invert(1)` and check). */
function supportsCanvasFilter(): boolean {
  try {
    const src = document.createElement('canvas')
    src.width = src.height = 2
    const sctx = src.getContext('2d')
    const dst = document.createElement('canvas')
    dst.width = dst.height = 2
    const dctx = dst.getContext('2d', { willReadFrequently: true })
    if (!sctx || !dctx) return false
    sctx.fillStyle = '#fff'
    sctx.fillRect(0, 0, 2, 2)
    dctx.filter = 'invert(1)'
    dctx.drawImage(src, 0, 0)
    return dctx.getImageData(0, 0, 1, 1).data[0] < 16
  } catch {
    return false
  }
}

const isCoarse = () => typeof window !== 'undefined' && !!window.matchMedia?.('(pointer: coarse)').matches

export class BloomRenderer {
  private bloomCanvas: HTMLCanvasElement
  private bloomCtx: CanvasRenderingContext2D
  private tempCanvas: HTMLCanvasElement
  private tempCtx: CanvasRenderingContext2D
  private intensity: number
  /** Canvas holding the latest blurred result (ping-pong ends on either buffer). */
  private result: HTMLCanvasElement
  private enabled: boolean
  /** Buffer scale relative to the source canvas, and frames between refreshes. */
  private readonly scale: number
  private readonly refreshEvery: number
  private frame = 0
  private hasResult = false

  constructor(intensity: number = 0.6) {
    this.intensity = intensity
    this.bloomCanvas = document.createElement('canvas')
    this.tempCanvas = document.createElement('canvas')
    const bCtx = this.bloomCanvas.getContext('2d')
    const tCtx = this.tempCanvas.getContext('2d')
    this.enabled = !!(bCtx && tCtx) && supportsCanvasFilter()
    this.bloomCtx = bCtx!
    this.tempCtx = tCtx!
    this.result = this.bloomCanvas
    // Phones: quarter resolution, refresh every 3rd frame. Desktop: half
    // resolution (as before), refresh every 2nd frame.
    const coarse = isCoarse()
    this.scale = coarse ? 0.25 : 0.5
    this.refreshEvery = coarse ? 3 : 2
  }

  resize(width: number, height: number): void {
    for (const c of [this.bloomCanvas, this.tempCanvas]) {
      c.width = Math.max(1, Math.round(width * this.scale))
      c.height = Math.max(1, Math.round(height * this.scale))
    }
    this.hasResult = false
    this.frame = 0
  }

  apply(sourceCanvas: HTMLCanvasElement, targetCtx: CanvasRenderingContext2D): void {
    const w = this.bloomCanvas.width
    const h = this.bloomCanvas.height
    if (w === 0 || h === 0 || !this.enabled) return

    if (!this.hasResult || this.frame++ % this.refreshEvery === 0) {
      // Thresholded downscale: brightness(0.5) then contrast(300%) crushes
      // anything below mid-gray so only genuinely bright pixels feed the bloom.
      const b = this.bloomCtx
      b.clearRect(0, 0, w, h)
      b.filter = 'brightness(0.5) contrast(300%)'
      b.drawImage(sourceCanvas, 0, 0, w, h)
      b.filter = 'none'

      // Three blur passes, ping-ponging between buffers (one drawImage each).
      // Radii are in buffer pixels, scaled to keep the same on-screen spread
      // as the original half-res 8/6/4.
      const k = this.scale / 0.5
      this.blurPass(this.bloomCtx, this.tempCtx, w, h, 8 * k)
      this.blurPass(this.tempCtx, this.bloomCtx, w, h, 6 * k)
      this.blurPass(this.bloomCtx, this.tempCtx, w, h, 4 * k)
      this.result = this.tempCanvas
      this.hasResult = true
    }

    // Composite additively. Reset transform first: targetCtx still carries the
    // dpr scale(), and drawing physical-pixel sizes through it would stretch
    // the bloom to dpr^2 of the intended area.
    targetCtx.save()
    targetCtx.setTransform(1, 0, 0, 1, 0, 0)
    targetCtx.globalCompositeOperation = 'lighter'
    targetCtx.globalAlpha = this.intensity
    targetCtx.drawImage(this.result, 0, 0, sourceCanvas.width, sourceCanvas.height)
    targetCtx.restore()
  }

  private blurPass(
    from: CanvasRenderingContext2D,
    to: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
  ): void {
    to.clearRect(0, 0, w, h)
    to.filter = `blur(${radius}px)`
    to.drawImage(from.canvas, 0, 0)
    to.filter = 'none'
  }

  setIntensity(intensity: number): void {
    this.intensity = Math.max(0, Math.min(1, intensity))
  }
}
