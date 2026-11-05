import type { Agent, ToolCallNode, Discovery } from '@/lib/agent-types'
import { NODE } from '@/lib/agent-types'
import {
  TOOL_MAX_CARD_W, getDiscoveryCardDimensions,
  HIT_DETECTION, TOOL_DRAW,
} from '@/lib/canvas-constants'
import { bubbleAlpha } from './bubble-utils'
import { getBubbleWorldRect, getToolWorldRect, getOverlayFrame } from './overlay-layout'

/**
 * Find which agent (if any) is at the given canvas-space coordinates.
 * Returns the agent id, or null.
 */
export function findAgentAt(
  x: number,
  y: number,
  agents: Map<string, Agent>,
): string | null {
  for (const [id, agent] of agents) {
    const size = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const dx = x - agent.x
    const dy = y - agent.y
    if (dx * dx + dy * dy < size * size) return id
  }
  return null
}

/**
 * Find which tool-call card (if any) is at the given canvas-space coordinates.
 * Returns the tool-call id, or null.
 */
export function findToolCallAt(
  x: number,
  y: number,
  toolCalls: Map<string, ToolCallNode>,
): string | null {
  for (const [id, tool] of toolCalls) {
    if (tool.opacity < 0.1) continue
    const placed = getToolWorldRect(tool)
    if (placed) {
      if (x >= placed.x && x <= placed.x + placed.w && y >= placed.y && y <= placed.y + placed.h) return id
      continue
    }
    // Hidden by declutter this frame: not clickable
    if (getOverlayFrame()) continue
    // Fallback (no layout frame yet): match the card dimensions from drawToolCalls
    const isRunning = tool.state === 'running'
    const isError = tool.state === 'error'
    const labelLen = (`${tool.toolName}: ${tool.args}`).length * HIT_DETECTION.toolCharWidth + 12
    const cardW = Math.max(60, Math.min(labelLen, TOOL_MAX_CARD_W))
    const cardH = (!isRunning && (tool.tokenCost || isError)) ? TOOL_DRAW.expandedHeight : TOOL_DRAW.collapsedHeight
    const cardX = tool.x - cardW / 2
    const cardY = tool.y - cardH / 2
    if (x >= cardX && x <= cardX + cardW && y >= cardY && y <= cardY + cardH) return id
  }
  return null
}

/**
 * Find which agent's message bubble (if any) is at the given canvas-space coordinates.
 * Uses the world-space rects recorded by the overlay layout pass (bubbles are
 * placed in screen space and may flip/clamp, so there is no fixed anchor to derive).
 */
export function findBubbleAgentAt(
  x: number,
  y: number,
  agents: Map<string, Agent>,
  currentTime: number,
): string | null {
  for (const agent of agents.values()) {
    if (agent.messageBubbles.length === 0) continue
    for (const bubble of agent.messageBubbles) {
      if (bubbleAlpha(currentTime - bubble.time, agent.opacity) < 0.01) continue
      const r = getBubbleWorldRect(bubble)
      if (r && x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) return agent.id
    }
  }
  return null
}

/**
 * Find which discovery card (if any) is at the given canvas-space coordinates.
 * Returns the discovery id, or null.
 */
export function findDiscoveryAt(
  x: number,
  y: number,
  discoveries: Discovery[],
): string | null {
  for (const disc of discoveries) {
    if (disc.opacity < 0.1) continue
    // Match the card dimensions from drawDiscoveries
    const lines = disc.content.split('\n')
    const { cardW, cardH } = getDiscoveryCardDimensions(disc.label, lines)
    const cardX = disc.x - cardW / 2
    const cardY = disc.y - cardH / 2
    if (x >= cardX && x <= cardX + cardW && y >= cardY && y <= cardY + cardH) return disc.id
  }
  return null
}
