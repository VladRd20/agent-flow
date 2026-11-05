import { Agent, ToolCallNode, MessageBubble, NODE } from '@/lib/agent-types'
import { contextSegments, getAgentGroupColor } from '@/lib/colors'
import {
  FONT, LABEL_STACK, OVERLAY_VIEWPORT_MARGIN, BUBBLE_ANCHOR_GAP, BUBBLE_MAX_W, BUBBLE_MAX_LINES,
  TOOL_MAX_CARD_W, CONTEXT_RING, AGENT_DRAW, screenFontPx,
} from '@/lib/canvas-constants'
import { formatTokens, formatModelName } from '@/lib/utils'
import { getNodeSizeMultiplier } from './node-size'
import { measureTextCached } from './render-cache'
import { truncateText, wrapText } from './draw-misc'
import { bubbleAlpha } from './bubble-utils'
import { layoutContextBar, usageRatio, formatUsagePercent, type BarLayout } from './context-meter'
import {
  PlacedRects, placeBest, intersectsViewport, clampRectToViewport, type Rect,
} from './overlay-rects'
import type { EasedValueMap } from './eased-value-map'

/**
 * Per-frame screen-space layout of everything textual that floats over the
 * graph: node label stacks (name + context bar + token line), message bubbles
 * and tool cards. A single priority-ordered pass keeps a list of placed rects
 * so lower-priority items are moved or faded out instead of overlapping.
 *
 * canvas.tsx calls beginOverlayFrame() once per frame (after the camera is
 * updated); draw-agents / draw-bubbles / draw-tool-calls read the plans.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export interface OverlayInput {
  ctx: CanvasRenderingContext2D
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  transform: { x: number; y: number; scale: number }
  /** CSS-pixel viewport size */
  viewport: { width: number; height: number }
  dpr: number
  deltaTime: number
  /** Sim time used for bubble lifetimes */
  simTime: number
  selectedAgentId: string | null
  hoveredAgentId: string | null
  selectedToolCallId?: string | null
  focusSet: Set<string> | null
  degreeMap: Map<string, number> | null
  /** Eased size multipliers (read-only peek, keyed `agent:${id}`) */
  sizeMap?: EasedValueMap
}

export type LabelMode = 'full' | 'compact'

export interface LabelPlan {
  id: string
  /** Node radius in world px (scale + degree size, no breathing) */
  r: number
  sx: number
  sy: number
  mode: LabelMode
  /** Plate rect in screen px (last placed position while fading out) */
  rect: Rect
  /** Column width shared by name, bar and token text */
  columnW: number
  name: string
  /** Display model name ("Opus 5.5") under the name, in the model-family color; null when unknown */
  modelText: string | null
  modelColor: string
  tokenText: string | null
  bar: BarLayout | null
  over: boolean
  /** Eased visibility 0..1 (declutter fade) */
  alpha: number
  /** True when declutter decided this label should currently be shown */
  shown: boolean
}

export interface BubbleItemPlan {
  bubble: MessageBubble
  y: number
  w: number
  h: number
  lines: string[]
  truncated: boolean
  alpha: number
  role: MessageBubble['role']
}

export interface BubblePlan {
  agentId: string
  rect: Rect
  items: BubbleItemPlan[]
  side: 'right' | 'left' | 'top' | 'bottom'
  sx: number
  sy: number
  nodeRpx: number
}

export interface ToolPlan {
  id: string
  rect: Rect
  ax: number
  ay: number
  displaced: boolean
  alpha: number
  shown: boolean
  label: string
  cardW: number
  cardH: number
}

export interface OverlayFrame {
  zoom: number
  dpr: number
  vw: number
  vh: number
  compact: boolean
  tx: number
  ty: number
  labelFont: string
  captionFont: string
  labelPx: number
  captionPx: number
  labels: Map<string, LabelPlan>
  bubbles: Map<string, BubblePlan>
  tools: Map<string, ToolPlan>
}

// ─── Persistent (cross-frame) state ─────────────────────────────────────────

interface FadeState { alpha: number; rect: Rect | null; mode?: LabelMode }
const labelFade = new Map<string, FadeState>()
const toolFade = new Map<string, FadeState>()

/** World-space rects of what was last drawn, for hit detection. */
const bubbleWorldRects = new WeakMap<MessageBubble, Rect>()
const toolWorldRects = new WeakMap<ToolCallNode, Rect>()

export function getBubbleWorldRect(b: MessageBubble): Rect | undefined { return bubbleWorldRects.get(b) }
export function getToolWorldRect(t: ToolCallNode): Rect | undefined { return toolWorldRects.get(t) }

let frame: OverlayFrame | null = null
export function getOverlayFrame(): OverlayFrame | null { return frame }
/** Test/teardown helper. */
export function resetOverlayState(): void {
  frame = null
  labelFade.clear()
  toolFade.clear()
}

function stepFade(map: Map<string, FadeState>, id: string, target: number, dt: number, rate: number): FadeState {
  let s = map.get(id)
  if (!s) { s = { alpha: 0, rect: null }; map.set(id, s) }
  const d = rate * Math.max(0, dt)
  s.alpha = s.alpha < target ? Math.min(target, s.alpha + d) : Math.max(target, s.alpha - d)
  return s
}

function sweepFade(map: Map<string, FadeState>, live: Set<string>): void {
  for (const id of map.keys()) if (!live.has(id)) map.delete(id)
}

// ─── Priority ───────────────────────────────────────────────────────────────

const ACTIVE_STATES = new Set(['thinking', 'tool_calling', 'waiting_permission', 'error'])

/** Higher = placed first and kept longer when space runs out. */
export function agentLabelPriority(
  agent: Pick<Agent, 'isMain' | 'state' | 'spawnTime'>,
  flags: { selected: boolean; hovered: boolean; focused: boolean },
  degree: number,
): number {
  let p = 0
  if (agent.isMain) p += 1000
  if (flags.selected) p += 900
  if (flags.hovered) p += 800
  if (flags.focused) p += 300
  if (ACTIVE_STATES.has(agent.state)) p += 200
  p += Math.min(degree, 40) * 4
  return p
}

/** Forced labels are always drawn, even if they have to overlap. */
export function isForcedLabel(agent: Pick<Agent, 'isMain'>, selected: boolean, hovered: boolean): boolean {
  return agent.isMain || selected || hovered
}

// ─── Helpers ────────────────────────────────────────────────────────────────

let coarseCached: boolean | null = null
function isCoarsePointer(): boolean {
  if (coarseCached === null) {
    coarseCached = typeof window !== 'undefined' && !!window.matchMedia && window.matchMedia('(pointer: coarse)').matches
  }
  return coarseCached
}

function snapPx(v: number, dpr: number): number {
  return Math.round(v * dpr) / dpr
}

/** Node radius in world px as used for layout (no breathing, so labels never shimmer). */
function layoutRadius(agent: Agent, id: string, degreeMap: Map<string, number> | null, sizeMap?: EasedValueMap): number {
  const base = agent.isMain ? NODE.radiusMain : NODE.radiusSub
  const target = degreeMap ? getNodeSizeMultiplier(id, degreeMap) : 1
  const mult = sizeMap ? sizeMap.peek(`agent:${id}`) ?? target : target
  return base * agent.scale * mult
}

/** Extra world radius occupied by rings around a node. */
function ringExtra(agent: Agent): number {
  return agent.isMain ? CONTEXT_RING.ringOffset + CONTEXT_RING.ringWidth / 2 + 2 : AGENT_DRAW.outerRingOffset + 2
}

/** Gap (screen px) between the name and the model line in a label stack. */
export const MODEL_LINE_GAP = 1

function tokenLine(ctx: CanvasRenderingContext2D, agent: Agent, maxW: number): string {
  const ratio = usageRatio(agent.tokensUsed, agent.tokensMax)
  const used = formatTokens(agent.tokensUsed)
  const max = formatTokens(agent.tokensMax)
  const pct = formatUsagePercent(ratio)
  const showPct = ratio >= 0.7
  const variants = [
    showPct ? `${used} / ${max} · ${pct}` : `${used} / ${max}`,
    `${used} / ${max}`,
    showPct ? `${used} · ${pct}` : used,
    used,
  ]
  for (const v of variants) if (measureTextCached(ctx, v) <= maxW) return v
  return variants[variants.length - 1]
}

// ─── Main entry point ───────────────────────────────────────────────────────

export function beginOverlayFrame(input: OverlayInput): OverlayFrame {
  const { ctx, agents, toolCalls, transform, viewport, dpr } = input
  const vw = viewport.width
  const vh = viewport.height
  const zoom = transform.scale > 0 ? transform.scale : 1
  const compact = vw <= 768 || isCoarsePointer()
  const labelPx = screenFontPx('label', zoom, compact)
  const captionPx = screenFontPx('caption', zoom, compact)
  const labelFont = FONT.mono(labelPx)
  const captionFont = FONT.mono(captionPx)

  const labels = new Map<string, LabelPlan>()
  const bubbles = new Map<string, BubblePlan>()
  const tools = new Map<string, ToolPlan>()
  const next: OverlayFrame = {
    zoom, dpr, vw, vh, compact, tx: transform.x, ty: transform.y,
    labelFont, captionFont, labelPx, captionPx, labels, bubbles, tools,
  }

  const placed = new PlacedRects()
  const pad = LABEL_STACK.rectPadding
  const margin = OVERLAY_VIEWPORT_MARGIN

  interface Entry {
    agent: Agent; id: string; r: number; sx: number; sy: number; priority: number
    forced: boolean; footprint: number
  }
  const entries: Entry[] = []

  // 1. Node footprints are hard obstacles for every overlay item.
  for (const [id, agent] of agents) {
    if (agent.opacity < 0.05) continue
    const r = layoutRadius(agent, id, input.degreeMap, input.sizeMap)
    const sx = agent.x * zoom + transform.x
    const sy = agent.y * zoom + transform.y
    const footprint = (r + ringExtra(agent)) * zoom
    const rect: Rect = { x: sx - footprint, y: sy - footprint, w: footprint * 2, h: footprint * 2 }
    if (!intersectsViewport(rect, vw, vh, 80)) continue
    placed.add(rect, id)
    const selected = id === input.selectedAgentId
    const hovered = id === input.hoveredAgentId
    const focused = input.focusSet ? input.focusSet.has(id) : false
    entries.push({
      agent, id, r, sx, sy, footprint,
      forced: isForcedLabel(agent, selected, hovered),
      priority: agentLabelPriority(agent, { selected, hovered, focused }, input.degreeMap?.get(id) ?? 0),
    })
  }
  entries.sort((a, b) => b.priority - a.priority || b.agent.spawnTime - a.agent.spawnTime)

  // 2. Label stacks, in priority order.
  const liveLabels = new Set<string>()
  for (const e of entries) {
    const { agent, id } = e
    ctx.font = labelFont
    const hasTokens = agent.tokensUsed > 0 && (agent.state !== 'complete' || agent.opacity > 0.5)
    const maxName = LABEL_STACK.maxWidth
    const nameFull = truncateText(ctx, agent.name, maxName)
    const nameW = measureTextCached(ctx, nameFull)
    ctx.font = captionFont
    const tokenText = hasTokens ? tokenLine(ctx, agent, LABEL_STACK.maxWidth) : null
    const tokW = tokenText ? measureTextCached(ctx, tokenText) : 0
    const modelText = agent.model ? truncateText(ctx, formatModelName(agent.model), LABEL_STACK.maxWidth) : null
    const modelW = modelText ? measureTextCached(ctx, modelText) : 0
    const columnW = Math.min(LABEL_STACK.maxWidth, Math.max(LABEL_STACK.minWidth * (hasTokens ? 1 : 0), nameW, tokW, modelW))

    const nameH = Math.ceil(labelPx * 1.25)
    const tokH = Math.ceil(captionPx * 1.25)
    // The model line sits under the name in both full and compact modes.
    const modelH = modelText ? MODEL_LINE_GAP + tokH : 0
    const fullH = LABEL_STACK.padY * 2 + nameH + modelH + (hasTokens ? LABEL_STACK.innerGap + LABEL_STACK.barHeight + LABEL_STACK.innerGap + tokH : 0)
    const compactColumnW = Math.min(LABEL_STACK.maxWidth, Math.max(nameW, modelW))
    const compactW = compactColumnW + LABEL_STACK.padX * 2
    const compactH = LABEL_STACK.padY * 2 + nameH + modelH
    const fullW = columnW + LABEL_STACK.padX * 2

    const top = e.sy + e.footprint + LABEL_STACK.gap
    const fullRect: Rect = { x: e.sx - fullW / 2, y: top, w: fullW, h: fullH }
    const compactRect: Rect = { x: e.sx - compactW / 2, y: top, w: compactW, h: compactH }
    const aboveRect: Rect = { x: e.sx - compactW / 2, y: e.sy - e.footprint - LABEL_STACK.gap - compactH, w: compactW, h: compactH }

    const candidates: Array<{ rect: Rect; mode: LabelMode }> = hasTokens
      ? [{ rect: fullRect, mode: 'full' }, { rect: compactRect, mode: 'compact' }, { rect: aboveRect, mode: 'compact' }]
      : [{ rect: compactRect, mode: 'compact' }, { rect: aboveRect, mode: 'compact' }]

    // Non-forced labels are only shown when a collision-free spot exists;
    // forced ones (main / selected / hovered) take the least-overlapping spot.
    const best = placeBest(candidates.map(c => c.rect), placed, vw, vh, margin, pad, id)
    if (!best) continue
    const mode = candidates[best.index].mode
    const shown = (best.clean || e.forced) && intersectsViewport(best.rect, vw, vh)

    const fade = stepFade(labelFade, id, shown ? 1 : 0, input.deltaTime, LABEL_STACK.fadeRate)
    liveLabels.add(id)
    if (shown) {
      placed.add(best.rect, `label:${id}`)
      fade.rect = best.rect
      fade.mode = mode
    }
    const rect = shown ? best.rect : fade.rect
    if (!rect || fade.alpha < 0.01) continue
    const effMode: LabelMode = shown ? mode : (fade.mode ?? mode)
    const effColumnW = effMode === 'full' ? columnW : compactColumnW

    const bar = effMode === 'full' && hasTokens
      ? layoutContextBar(contextSegments(agent.contextBreakdown), agent.tokensUsed, agent.tokensMax)
      : null
    labels.set(id, {
      id, r: e.r, sx: e.sx, sy: e.sy, mode: effMode, rect, columnW: effColumnW,
      name: nameFull, modelText, modelColor: getAgentGroupColor(agent),
      tokenText: effMode === 'full' ? tokenText : null, bar,
      over: usageRatio(agent.tokensUsed, agent.tokensMax) > 1,
      alpha: fade.alpha, shown,
    })
  }
  sweepFade(labelFade, liveLabels)

  // 3. Message bubbles (placed after labels; try right, left, above, below).
  const maxBubbles = compact ? 2 : 3
  const bubbleMaxW = Math.min(BUBBLE_MAX_W, Math.max(120, vw * 0.62))
  const bubbleLines = compact ? 4 : BUBBLE_MAX_LINES
  const bPad = 7
  const lineH = Math.ceil(captionPx * 1.35)
  const headerH = captionPx + 6
  for (const e of entries) {
    const list = e.agent.messageBubbles
    if (list.length === 0) continue
    const live: BubbleItemPlan[] = []
    const recent = list.slice(-maxBubbles)
    let blockW = 0
    let y = 0
    for (const bubble of recent) {
      const alpha = bubbleAlpha(input.simTime - bubble.time, e.agent.opacity)
      if (alpha < 0.01) continue
      const font = FONT.mono(captionPx)
      ctx.font = font
      const wrapW = bubbleMaxW - bPad * 2
      const cacheKey = `${font}|${Math.round(wrapW)}`
      let allLines: string[]
      if (bubble._cachedWrappedLines && bubble._cachedWrappedFont === cacheKey) allLines = bubble._cachedWrappedLines
      else {
        allLines = wrapText(ctx, bubble.text, wrapW)
        bubble._cachedWrappedLines = allLines
        bubble._cachedWrappedFont = cacheKey
      }
      const truncated = allLines.length > bubbleLines
      const lines = truncated ? allLines.slice(0, bubbleLines) : allLines
      let widest = 0
      for (const l of lines) widest = Math.max(widest, measureTextCached(ctx, l))
      const w = Math.min(bubbleMaxW, Math.max(widest, 60) + bPad * 2)
      const h = headerH + lines.length * lineH + bPad + (truncated ? lineH : 0)
      bubble._cachedW = w
      bubble._cachedH = h
      bubble._cachedLines = lines.length
      live.push({ bubble, y, w, h, lines, truncated, alpha, role: bubble.role })
      blockW = Math.max(blockW, w)
      y += h + 6
    }
    if (live.length === 0) continue
    const blockH = y - 6
    const gap = BUBBLE_ANCHOR_GAP
    const nodeHalf = e.footprint
    const labelRect = labels.get(e.id)?.rect
    const topY = e.sy - Math.min(14, blockH / 2)
    const cands: Array<{ rect: Rect; side: BubblePlan['side'] }> = [
      { rect: { x: e.sx + nodeHalf + gap, y: topY, w: blockW, h: blockH }, side: 'right' },
      { rect: { x: e.sx - nodeHalf - gap - blockW, y: topY, w: blockW, h: blockH }, side: 'left' },
      { rect: { x: e.sx - blockW / 2, y: e.sy - nodeHalf - gap - blockH, w: blockW, h: blockH }, side: 'top' },
      { rect: { x: e.sx - blockW / 2, y: (labelRect ? labelRect.y + labelRect.h : e.sy + nodeHalf) + gap, w: blockW, h: blockH }, side: 'bottom' },
    ]
    const best = placeBest(cands.map(c => c.rect), placed, vw, vh, margin, pad, e.id)
    if (!best) continue
    const side = cands[best.index].side
    placed.add(best.rect, `bubble:${e.id}`)
    for (const it of live) {
      const wr: Rect = {
        x: (best.rect.x - transform.x) / zoom, y: (best.rect.y + it.y - transform.y) / zoom,
        w: it.w / zoom, h: it.h / zoom,
      }
      bubbleWorldRects.set(it.bubble, wr)
    }
    bubbles.set(e.id, { agentId: e.id, rect: best.rect, items: live, side, sx: e.sx, sy: e.sy, nodeRpx: nodeHalf })
  }

  // 4. Tool cards: clamped into the viewport, nudged away from everything placed.
  const toolList: Array<{ id: string; tool: ToolCallNode; score: number }> = []
  for (const [id, tool] of toolCalls) {
    if (tool.opacity < 0.05) continue
    const important = tool.state === 'running' || tool.state === 'error' || id === input.selectedToolCallId
    toolList.push({ id, tool, score: (id === input.selectedToolCallId ? 3 : important ? 2 : 1) * 1e12 + tool.startTime })
  }
  toolList.sort((a, b) => b.score - a.score)
  const liveTools = new Set<string>()
  const cardMaxW = Math.min(TOOL_MAX_CARD_W + 30, Math.max(110, vw * 0.6))
  for (const { id, tool } of toolList) {
    const ax = tool.x * zoom + transform.x
    const ay = tool.y * zoom + transform.y
    const isRunning = tool.state === 'running'
    const isError = tool.state === 'error'
    const important = isRunning || isError || id === input.selectedToolCallId
    const expanded = !isRunning && (!!tool.tokenCost || isError)
    ctx.font = captionFont
    const label = truncateText(ctx, `${tool.toolName}: ${tool.args}`, cardMaxW - 14)
    const cardW = Math.min(cardMaxW, Math.max(64, measureTextCached(ctx, label) + 14))
    const cardH = Math.ceil(captionPx * 1.25) + 10 + (expanded ? Math.ceil(captionPx * 1.2) : 0)
    const base: Rect = { x: ax - cardW / 2, y: ay - cardH / 2, w: cardW, h: cardH }
    if (!intersectsViewport(base, vw, vh, 160)) continue
    const step = cardH + 4
    const shifts: Array<[number, number]> = [
      [0, 0], [0, -step], [0, step], [cardW * 0.6, 0], [-cardW * 0.6, 0],
      [0, -step * 2], [0, step * 2], [cardW * 0.6, -step], [-cardW * 0.6, -step],
    ]
    const cands = shifts.map(([dx, dy]) => ({ x: base.x + dx, y: base.y + dy, w: cardW, h: cardH }))
    const best = placeBest(cands, placed, vw, vh, margin, 2)
    const shown = !!best && (best.clean || important)
    const fade = stepFade(toolFade, id, shown ? 1 : 0, input.deltaTime, LABEL_STACK.fadeRate)
    liveTools.add(id)
    if (shown && best) { placed.add(best.rect, `tool:${id}`); fade.rect = best.rect }
    const rect = shown && best ? best.rect : fade.rect
    if (!rect || fade.alpha < 0.01) continue
    const dist = Math.hypot(rect.x + rect.w / 2 - ax, rect.y + rect.h / 2 - ay)
    tools.set(id, {
      id, rect, ax, ay, displaced: dist > Math.max(rect.h / 2, 6) + 3, alpha: fade.alpha, shown, label, cardW, cardH,
    })
    if (shown) {
      toolWorldRects.set(tool, {
        x: (rect.x - transform.x) / zoom, y: (rect.y - transform.y) / zoom, w: rect.w / zoom, h: rect.h / zoom,
      })
    } else {
      toolWorldRects.delete(tool)
    }
  }
  sweepFade(toolFade, liveTools)

  frame = next
  return next
}

export { snapPx, clampRectToViewport }
