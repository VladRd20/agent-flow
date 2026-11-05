import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  layoutContextBar, layoutContextRing, formatUsagePercent, usageRatio, FULL_TURN,
} from './context-meter'
import {
  PlacedRects, placeBest, clampRectToViewport, rectsOverlap, type Rect,
} from './overlay-rects'
import { collideRadiusFor, suggestForceParams } from './layout-metrics'
import { agentLabelPriority, isForcedLabel } from './overlay-layout'
import { screenFontPx, TYPE, FONT, FONT_STACK } from '@/lib/canvas-constants'

const SEGS = [
  { value: 100, color: 'a' },
  { value: 300, color: 'b' },
  { value: 0, color: 'c' },
  { value: 600, color: 'd' },
]

// ─── context meter ──────────────────────────────────────────────────────────

test('bar fill is clamped to 1 and segments never pass the bar end when over capacity', () => {
  const bar = layoutContextBar(SEGS, 2061_000, 1000_000)
  assert.equal(bar.fill, 1)
  assert.equal(bar.over, true)
  for (const s of bar.segments) {
    assert.ok(s.start >= 0 && s.end <= 1 + 1e-9, `segment ${s.color} within bar`)
  }
  assert.ok(bar.segments[bar.segments.length - 1].end <= 1 + 1e-9)
})

test('bar segments scale to the filled width under capacity', () => {
  const bar = layoutContextBar([{ value: 250, color: 'a' }, { value: 250, color: 'b' }], 500, 1000)
  assert.equal(bar.over, false)
  assert.equal(bar.fill, 0.5)
  assert.ok(Math.abs(bar.segments[1].end - 0.5) < 1e-9)
})

test('bar handles zero / invalid capacity without NaN', () => {
  const bar = layoutContextBar(SEGS, 500, 0)
  assert.equal(bar.fill, 1)
  assert.ok(bar.segments.every(s => Number.isFinite(s.start) && Number.isFinite(s.end)))
  assert.equal(layoutContextBar(SEGS, 0, 1000).segments.length, 0)
  assert.equal(usageRatio(NaN, 10), 0)
})

test('ring sweeps are clamped to one full turn when tokens exceed the window', () => {
  const arcs = layoutContextRing(SEGS, 5_000_000, 1_000_000)
  assert.ok(arcs.length > 0)
  const first = arcs[0].start
  const last = arcs[arcs.length - 1].end
  assert.ok(last - first <= FULL_TURN + 1e-9)
  // contiguous, no wrap-over
  for (let i = 1; i < arcs.length; i++) assert.ok(Math.abs(arcs[i].start - arcs[i - 1].end) < 1e-9)
})

test('ring under capacity sweeps proportionally to the window', () => {
  const arcs = layoutContextRing([{ value: 250, color: 'a' }], 250, 1000)
  assert.ok(Math.abs((arcs[0].end - arcs[0].start) - FULL_TURN * 0.25) < 1e-9)
})

test('percent formatting is bounded', () => {
  assert.equal(formatUsagePercent(0.62), '62%')
  assert.equal(formatUsagePercent(2.06), '206%')
  assert.equal(formatUsagePercent(50), '>999%')
  assert.equal(formatUsagePercent(NaN), '0%')
})

// ─── rect placement / declutter ─────────────────────────────────────────────

const VW = 390
const VH = 844

test('rectsOverlap respects padding', () => {
  const a: Rect = { x: 0, y: 0, w: 10, h: 10 }
  const b: Rect = { x: 12, y: 0, w: 10, h: 10 }
  assert.equal(rectsOverlap(a, b), false)
  assert.equal(rectsOverlap(a, b, 3), true)
})

test('clampRectToViewport keeps rects on screen', () => {
  const r = clampRectToViewport({ x: -50, y: 900, w: 100, h: 40 }, VW, VH, 6)
  assert.equal(r.x, 6)
  assert.equal(r.y, VH - 6 - 40)
  const wide = clampRectToViewport({ x: 0, y: 0, w: 500, h: 10 }, VW, VH, 6)
  assert.equal(wide.x, 6) // wider than viewport: pinned to the margin, never negative
})

test('placeBest takes the first collision-free candidate and clamps into view', () => {
  const placed = new PlacedRects()
  placed.add({ x: 100, y: 100, w: 80, h: 40 })
  const blocked: Rect = { x: 110, y: 110, w: 60, h: 20 }
  const free: Rect = { x: 110, y: 200, w: 60, h: 20 }
  const res = placeBest([blocked, free], placed, VW, VH, 6, 2)
  assert.ok(res && res.clean)
  assert.equal(res!.index, 1)
})

test('placeBest falls back to least overlap and reports not clean', () => {
  const placed = new PlacedRects()
  placed.add({ x: 0, y: 0, w: 400, h: 400 })
  const heavy: Rect = { x: 10, y: 10, w: 100, h: 100 }
  const light: Rect = { x: 350, y: 380, w: 100, h: 100 }
  const res = placeBest([heavy, light], placed, 1000, 1000, 0, 0)
  assert.ok(res && !res.clean)
  assert.equal(res!.index, 1)
})

test('placeBest ignores obstacles owned by the item itself', () => {
  const placed = new PlacedRects()
  placed.add({ x: 0, y: 0, w: 50, h: 50 }, 'node-a')
  const res = placeBest([{ x: 10, y: 10, w: 20, h: 20 }], placed, VW, VH, 0, 0, 'node-a')
  assert.ok(res && res.clean)
})

test('priority order: main > selected > hovered > active > idle', () => {
  const idle = { isMain: false, state: 'idle', spawnTime: 0 } as const
  const active = { isMain: false, state: 'thinking', spawnTime: 0 } as const
  const main = { isMain: true, state: 'idle', spawnTime: 0 } as const
  const none = { selected: false, hovered: false, focused: false }
  const pMain = agentLabelPriority(main, none, 0)
  const pSel = agentLabelPriority(idle, { ...none, selected: true }, 0)
  const pHover = agentLabelPriority(idle, { ...none, hovered: true }, 0)
  const pActive = agentLabelPriority(active, none, 0)
  const pIdle = agentLabelPriority(idle, none, 0)
  assert.ok(pMain > pSel && pSel > pHover && pHover > pActive && pActive > pIdle)
  assert.ok(agentLabelPriority(idle, none, 10) > pIdle, 'degree breaks ties')
  assert.equal(isForcedLabel({ isMain: false }, false, false), false)
  assert.equal(isForcedLabel({ isMain: false }, false, true), true)
})

// ─── collide radius / force params ──────────────────────────────────────────

test('collideRadiusFor grows with size multiplier and covers the label stack', () => {
  const sub = collideRadiusFor({ isMain: false })
  const bigSub = collideRadiusFor({ isMain: false }, { sizeMultiplier: 1.6, labelHalfWidthPx: 10 })
  const main = collideRadiusFor({ isMain: true }, { labelHalfWidthPx: 10 })
  assert.ok(sub > 20 + 14, 'larger than the bare node + padding (label stack allowance)')
  assert.ok(main > bigSub - 40)
  const wide = collideRadiusFor({ isMain: false }, { labelHalfWidthPx: 120 })
  assert.ok(wide >= 120 + 8, 'label half width dominates for long names')
  // zoomed out: world radius must grow because the label stack is constant screen size
  assert.ok(collideRadiusFor({ isMain: false }, { zoom: 0.5 }) > sub)
})

test('collideRadiusFor tolerates bad zoom', () => {
  assert.ok(Number.isFinite(collideRadiusFor({ isMain: true }, { zoom: 0 })))
})

test('suggestForceParams scales with node count and stays bounded', () => {
  const small = suggestForceParams(3)
  const big = suggestForceParams(15)
  const huge = suggestForceParams(500)
  assert.ok(Math.abs(big.chargeStrength) > Math.abs(small.chargeStrength))
  assert.ok(big.linkDistance > small.linkDistance)
  assert.ok(Math.abs(huge.chargeStrength) <= 2600)
  assert.ok(huge.linkDistance <= 460)
})

// ─── type scale ─────────────────────────────────────────────────────────────

test('screenFontPx stays within the level bounds at any zoom', () => {
  for (const zoom of [0.05, 0.3, 1, 2, 8, 100]) {
    for (const level of ['caption', 'label', 'title'] as const) {
      const px = screenFontPx(level, zoom)
      assert.ok(px >= TYPE[level].min && px <= TYPE[level].max, `${level}@${zoom}=${px}`)
    }
  }
})

test('screenFontPx is near-constant, bumped on coarse, and robust to bad zoom', () => {
  assert.equal(screenFontPx('label', 1), TYPE.label.base)
  assert.equal(screenFontPx('label', 1, true), TYPE.label.base + 1)
  assert.ok(screenFontPx('caption', 0.2) >= 10, 'never below the legibility floor')
  assert.equal(screenFontPx('label', NaN), TYPE.label.base)
  assert.equal(screenFontPx('label', -1), TYPE.label.base)
})

test('FONT.mono builds a canvas font with the shared stack', () => {
  assert.equal(FONT.mono(11), `11px ${FONT_STACK}`)
  assert.equal(FONT.mono(10, 'bold'), `bold 10px ${FONT_STACK}`)
  assert.equal(FONT.mono(10, 'normal', true), `italic 10px ${FONT_STACK}`)
})
