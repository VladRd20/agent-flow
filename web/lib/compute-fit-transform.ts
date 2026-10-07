import { Agent, ToolCallNode, Discovery, ANIM, NODE } from './agent-types'
import { BUBBLE_HOLD, BUBBLE_FADE_OUT, BUBBLE_MAX_W, TOOL_CARD_W, TOOL_CARD_H, DISC_BOUNDS_HALF_W, DISC_BOUNDS_HALF_H } from './canvas-constants'

/** Extra padding added to agent node radii for auto-fit bounding box */
const AUTOFIT_AGENT_PADDING = 22

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
}

export interface FitCache {
  agents: Map<string, Agent> | null
  toolCalls: Map<string, ToolCallNode> | null
  discoveries: Discovery[] | null
  selectedAgentId: string | null
  width: number
  height: number
  result: Transform | null
}

export function createFitCache(): FitCache {
  return { agents: null, toolCalls: null, discoveries: null, selectedAgentId: null, width: -1, height: -1, result: null }
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
  if (agents.size === 0) return null

  // Return cached result if inputs haven't changed (reference equality for
  // collections — React creates new Map/array objects on state updates — plus
  // viewport dimensions, which affect the computed scale/offset independently
  // of collection identity, e.g. on a window resize with no new sim events).
  if (cache.agents === agents
    && cache.toolCalls === toolCalls
    && cache.discoveries === discoveries
    && cache.selectedAgentId === selectedAgentId
    && cache.width === dimensions.width
    && cache.height === dimensions.height) {
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

  if (minX === Infinity) {
    cache.result = null
    return null
  }
  const padding = ANIM.viewportPadding
  const boundsW = maxX - minX + padding * 2
  const boundsH = maxY - minY + padding * 2
  const centerX = (minX + maxX) / 2
  const centerY = (minY + maxY) / 2
  const scale = Math.min(dimensions.width / boundsW, dimensions.height / boundsH, 2)
  const result = {
    x: dimensions.width / 2 - centerX * scale,
    y: dimensions.height / 2 - centerY * scale,
    scale,
  }
  cache.result = result
  return result
}
