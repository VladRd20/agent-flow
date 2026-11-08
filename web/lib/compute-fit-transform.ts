import { Agent, ToolCallNode, Discovery, ANIM, NODE } from './agent-types'
import { BUBBLE_HOLD, BUBBLE_FADE_OUT, BUBBLE_MAX_W, TOOL_CARD_W, TOOL_CARD_H, DISC_BOUNDS_HALF_W, DISC_BOUNDS_HALF_H } from './canvas-constants'

/** Extra padding added to agent node radii for auto-fit bounding box */
const AUTOFIT_AGENT_PADDING = 22
/** Screen px reserved under the lowest node for its name/context label stack. */
const FIT_LABEL_ROOM = 32
/** Auto-fit never zooms a sparse graph (e.g. a lone orchestrator) in past this. */
const FIT_MAX_SCALE = 1.5
/** Fit the whole graph when natural zoom is within this fraction of the label-clearance floor. */
const FIT_CLAMP_TOLERANCE = 0.85

/** Screen px a main's label plate needs on each axis before neighbouring plates stop overlapping. */
const LABEL_CLEAR_X = 170
const LABEL_CLEAR_Y = 105

/**
 * Smallest zoom at which every pair of session mains keeps clear label plates
 * (labels are a fixed screen size, so squeezing many clusters in just stacks
 * them on top of each other). Two mains are clear when separated by enough
 * screen px horizontally OR vertically. 0 unless 2+ mains carry a sessionId
 * (the All view), so single-session fitting is untouched.
 */
export function minLabelClearScale(agents: Iterable<Pick<Agent, 'isMain' | 'sessionId' | 'x' | 'y'>>): number {
  const mains: { x: number; y: number }[] = []
  for (const a of agents) if (a.isMain && a.sessionId) mains.push(a)
  let need = 0
  for (let i = 0; i < mains.length; i++) {
    for (let j = i + 1; j < mains.length; j++) {
      const dx = Math.abs(mains[i].x - mains[j].x)
      const dy = Math.abs(mains[i].y - mains[j].y)
      const pair = Math.min(dx > 0 ? LABEL_CLEAR_X / dx : Infinity, dy > 0 ? LABEL_CLEAR_Y / dy : Infinity)
      if (Number.isFinite(pair)) need = Math.max(need, pair)
    }
  }
  return need
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export interface Transform {
  x: number
  y: number
  scale: number
}

export interface FitInput {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  discoveries: Discovery[]
  dimensions: { width: number; height: number }
  selectedAgentId: string | null
  simTime: number
  /** Pixels at the bottom of the viewport covered by chrome (e.g. control bar); fit centers above it */
  bottomInset?: number
  /** Pixels at the top of the viewport covered by chrome (top bar, message pill); fit centers below it */
  topInset?: number
  /** Pixels at the right of the viewport covered by chrome (wide-layout cost card); fit centers left of it */
  rightInset?: number
}

export interface FitCache {
  agents: Map<string, Agent> | null
  toolCalls: Map<string, ToolCallNode> | null
  discoveries: Discovery[] | null
  selectedAgentId: string | null
  width: number
  height: number
  bottomInset: number
  topInset: number
  rightInset: number
  result: Transform | null
}

export function createFitCache(): FitCache {
  return { agents: null, toolCalls: null, discoveries: null, selectedAgentId: null, width: -1, height: -1, bottomInset: 0, topInset: 0, rightInset: 0, result: null }
}

/** Collect an agent and all its descendants (BFS) */
export function getDescendantIds(agents: Map<string, Agent>, rootId: string): Set<string> {
  const ids = new Set<string>([rootId])
  const queue = [rootId]
  while (queue.length > 0) {
    const parentId = queue.shift()!
    for (const [id, agent] of agents) {
      if (agent.parentId === parentId && !ids.has(id)) {
        ids.add(id)
        queue.push(id)
      }
    }
  }
  return ids
}

/**
 * Computes the camera transform that fits all visible agents/tool calls/discoveries
 * in view, with memoization keyed on collection identity AND viewport dimensions.
 *
 * Mutates `cache` in place and returns the (possibly cached) result.
 */
export function computeFitTransform(input: FitInput, cache: FitCache): Transform | null {
  const { agents, toolCalls, discoveries, dimensions, selectedAgentId, simTime } = input
  const bottomInset = Math.max(0, input.bottomInset ?? 0)
  const topInset = Math.max(0, input.topInset ?? 0)
  const rightInset = Math.max(0, input.rightInset ?? 0)
  // Collapsed/hidden container (ResizeObserver can report 0 transiently): no fit
  if (agents.size === 0 || !(dimensions.width > 0) || !(dimensions.height > 0)) return null

  // Return cached result if inputs haven't changed (reference equality for
  // collections — React creates new Map/array objects on state updates — plus
  // viewport dimensions, which affect the computed scale/offset independently
  // of collection identity, e.g. on a window resize with no new sim events).
  if (cache.agents === agents
    && cache.toolCalls === toolCalls
    && cache.discoveries === discoveries
    && cache.selectedAgentId === selectedAgentId
    && cache.width === dimensions.width
    && cache.height === dimensions.height
    && cache.bottomInset === bottomInset
    && cache.topInset === topInset
    && cache.rightInset === rightInset) {
    return cache.result
  }

  // Determine focus scope: if a non-main agent is selected, focus on it + descendants
  let focusScope: Set<string> | null = null
  if (selectedAgentId) {
    const selected = agents.get(selectedAgentId)
    if (selected && !selected.isMain) {
      focusScope = getDescendantIds(agents, selectedAgentId)
    }
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const [id, agent] of agents) {
    if (focusScope && !focusScope.has(id)) continue
    // Not faded in yet (just spawned) - exclude from the fit bbox, same as
    // the opacity guard already applied to toolCalls/discoveries below.
    // Otherwise a brand-new node (opacity 0, possibly at a not-yet-correct
    // position) can force an extreme fit on the very next frame, shrinking
    // every already-visible node to sub-pixel until it fades in/settles.
    if (agent.opacity <= 0.1) continue
    const r = (agent.isMain ? NODE.radiusMain : NODE.radiusSub) + AUTOFIT_AGENT_PADDING
    minX = Math.min(minX, agent.x - r)
    maxX = Math.max(maxX, agent.x + r)
    minY = Math.min(minY, agent.y - r)
    maxY = Math.max(maxY, agent.y + r)
    if (agent.messageBubbles.length > 0) {
      const visibleCount = agent.messageBubbles.filter(b => {
        const age = (simTime ?? 0) - b.time
        return age <= BUBBLE_HOLD + BUBBLE_FADE_OUT
      }).length
      if (visibleCount > 0) {
        maxX = Math.max(maxX, agent.x + r + 14 + BUBBLE_MAX_W * 0.4)
        minX = Math.min(minX, agent.x - r - BUBBLE_MAX_W * 0.2)
        const stackH = visibleCount * 46
        minY = Math.min(minY, agent.y - 20)
        maxY = Math.max(maxY, agent.y - 20 + stackH)
      }
    }
  }
  for (const [, tool] of toolCalls) {
    if (tool.opacity > 0.1 && (!focusScope || focusScope.has(tool.agentId))) {
      const halfW = TOOL_CARD_W / 2
      const halfH = TOOL_CARD_H / 2
      minX = Math.min(minX, tool.x - halfW)
      maxX = Math.max(maxX, tool.x + halfW)
      minY = Math.min(minY, tool.y - halfH)
      maxY = Math.max(maxY, tool.y + halfH)
    }
  }
  for (const disc of discoveries) {
    if (disc.opacity > 0.1 && (!focusScope || focusScope.has(disc.agentId))) {
      minX = Math.min(minX, disc.x - DISC_BOUNDS_HALF_W)
      maxX = Math.max(maxX, disc.x + DISC_BOUNDS_HALF_W)
      minY = Math.min(minY, disc.y - DISC_BOUNDS_HALF_H)
      maxY = Math.max(maxY, disc.y + DISC_BOUNDS_HALF_H)
    }
  }

  cache.agents = agents
  cache.toolCalls = toolCalls
  cache.discoveries = discoveries
  cache.selectedAgentId = selectedAgentId
  cache.width = dimensions.width
  cache.height = dimensions.height
  cache.bottomInset = bottomInset
  cache.topInset = topInset
  cache.rightInset = rightInset

  if (minX === Infinity) {
    cache.result = null
    return null
  }
  const boundsW = Math.max(maxX - minX, 1)
  const boundsH = Math.max(maxY - minY, 1)
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  // Fit within the band not covered by top/bottom chrome. If the chrome would
  // leave under 25% of the height, shrink both insets proportionally instead.
  let top = topInset, bottom = bottomInset
  const minH = dimensions.height * 0.25
  if (dimensions.height - top - bottom < minH && top + bottom > 0) {
    const k = (dimensions.height - minH) / (top + bottom)
    top *= k
    bottom *= k
  }
  const availH = dimensions.height - top - bottom
  // Padding is in screen px, not world units: world padding would eat most of
  // a short (landscape phone) viewport once zoomed out. Labels hang below
  // nodes at a constant screen size, so the bottom pad is larger.
  const padX = clamp(dimensions.width * 0.08, 24, ANIM.viewportPadding)
  const padTop = clamp(availH * 0.05, 12, 48)
  const padBottom = padTop + FIT_LABEL_ROOM
  // Reserve the right-hand overlay, but never more than 40% of the width.
  const right = Math.min(rightInset, dimensions.width * 0.4)
  const availW = dimensions.width - right
  const innerW = Math.max(availW - padX * 2, availW * 0.5)
  const innerH = Math.max(availH - padTop - padBottom, availH * 0.5)
  const natural = Math.min(innerW / boundsW, innerH / boundsH, FIT_MAX_SCALE)
  // All view: don't zoom out past the point where cluster labels collide. If that
  // clamps the zoom the graph no longer fits, so frame the top clusters (the user pans down).
  const minScale = focusScope ? 0 : Math.min(minLabelClearScale(agents.values()), FIT_MAX_SCALE)
  // A graph that only just misses the label-clearance floor is shown whole (the declutter pass
  // hides colliding labels) rather than leaving its lowest node half under the control bar.
  const clamped = minScale > natural && natural < minScale * FIT_CLAMP_TOLERANCE
  const scale = clamped ? minScale : natural
  const bandTop = availH - padTop - padBottom >= availH * 0.5 ? top + padTop : top + (availH - innerH) / 2
  const result = {
    x: availW / 2 - centerX * scale,
    y: clamped ? top + padTop - minY * scale : bandTop + innerH / 2 - centerY * scale,
    scale,
  }
  cache.result = result
  return result
}
