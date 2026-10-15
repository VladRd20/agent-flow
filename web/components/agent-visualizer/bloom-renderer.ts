/**
 * Bloom post-processing for holographic glow effect.
 * Takes the main canvas, extracts bright areas, blurs them,
 * and composites back with additive blending.
 */

export class BloomRenderer {
  private bloomCanvas: HTMLCanvasElement
  private bloomCtx: CanvasRenderingContext2D
  private tempCanvas: HTMLCanvasElement
  private tempCtx: CanvasRenderingContext2D
  private intensity: number

  private enabled: boolean

  constructor(intensity: number = 0.6) {
    this.intensity = intensity
    this.bloomCanvas = document.createElement('canvas')
    this.tempCanvas = document.createElement('canvas')
    const bCtx = this.bloomCanvas.getContext('2d')
    const tCtx = this.tempCanvas.getContext('2d')
    this.enabled = !!(bCtx && tCtx)
    this.bloomCtx = bCtx!
    this.tempCtx = tCtx!
  }

  resize(width: number, height: number): void {
    // Bloom at half resolution for performance
    const scale = 0.5
    this.bloomCanvas.width = width * scale
    this.bloomCanvas.height = height * scale
    this.tempCanvas.width = width * scale
    this.tempCanvas.height = height * scale
  }

  apply(sourceCanvas: HTMLCanvasElement, targetCtx: CanvasRenderingContext2D): void {
    const w = this.bloomCanvas.width
    const h = this.bloomCanvas.height

    if (w === 0 || h === 0 || !this.enabled) return

    // Draw source at half resolution, thresholded so only genuinely bright
    // pixels (node strokes, glow sprites, beams) feed the bloom buffer.
    // Without this, the *whole* scene — including hard edges and label
    // text — gets a blurred duplicate composited back on top of itself,
    // which reads as the entire canvas being soft/blurry rather than as a
    // glow around bright elements. brightness(0.5) first dims everything,
    // then contrast(300%) crushes anything still below mid-gray to black
    // while pushing genuinely bright pixels up — a cheap luminance
    // threshold using only standard canvas filters.
    this.bloomCtx.clearRect(0, 0, w, h)
    this.bloomCtx.filter = 'brightness(0.5) contrast(300%)'
    this.bloomCtx.drawImage(sourceCanvas, 0, 0, w, h)
    this.bloomCtx.filter = 'none'

    // Apply blur passes (box blur approximation of gaussian)
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 8)
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 6)
    this.boxBlur(this.bloomCtx, this.tempCtx, w, h, 4)

    // Composite bloom over the target with additive blending.
    // targetCtx still has canvas.tsx's devicePixelRatio scale() active at
    // this point (it's only reset when the canvas itself is resized, not
    // saved/restored around this call) — drawing sourceCanvas's PHYSICAL
    // pixel dimensions through an already-dpr-scaled context stretched the
    // blurred bloom buffer to dpr² the intended area, washing out the
    // whole canvas on any non-1 devicePixelRatio display. Reset to the
    // identity transform first so the draw call's own dimensions are the
    // only scaling in effect.
    targetCtx.save()
    targetCtx.setTransform(1, 0, 0, 1, 0, 0)
    targetCtx.globalCompositeOperation = 'lighter'
    targetCtx.globalAlpha = this.intensity
    targetCtx.drawImage(this.bloomCanvas, 0, 0, sourceCanvas.width, sourceCanvas.height)
    targetCtx.restore()
  }

  private boxBlur(
    srcCtx: CanvasRenderingContext2D,
    tmpCtx: CanvasRenderingContext2D,
    w: number,
    h: number,
    radius: number,
  ): void {
    // Use CSS filter for fast blur
    tmpCtx.clearRect(0, 0, w, h)
    tmpCtx.filter = `blur(${radius}px)`
    tmpCtx.drawImage(srcCtx.canvas, 0, 0)
    tmpCtx.filter = 'none'

    srcCtx.clearRect(0, 0, w, h)
    srcCtx.drawImage(tmpCtx.canvas, 0, 0)
  }

  setIntensity(intensity: number): void {
    this.intensity = Math.max(0, Math.min(1, intensity))
  }
}
