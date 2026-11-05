import { NODE } from '@/lib/agent-types'

/** Approximate height (screen px) of the name + bar + token label stack. */
export const LABEL_STACK_HEIGHT_PX = 44

/** Typical half-width (screen px) of a name + token label stack. */
export const TYPICAL_LABEL_HALF_WIDTH_PX = 56

export interface CollideAgent { isMain: boolean; scale?: number }
export interface CollideOptions {
  /** Degree-based size multiplier (getNodeSizeMultiplier). Default 1. */
  sizeMultiplier?: number
  /** Camera zoom the layout is expected to be viewed at (the label stack is constant screen size). Default 1. */
  zoom?: number
  /** Half-width of the label stack in screen px. Default = typical stack width / 2 (56). */
  labelHalfWidthPx?: number
  /** Extra world-px padding around the node. Default 14. */
  pad?: number
}

/**
 * Collision radius (world px) for d3-force's forceCollide so neighbouring nodes
 * keep room for both the hexagon and its label stack:
 *   max(nodeR * sizeMult + pad, labelHalfWidth + 8) + vertical allowance
 * where the vertical allowance is half the label stack height (the stack hangs
 * below the node, and forceCollide is a circle centred on the node).
 */
export function collideRadiusFor(agent: CollideAgent, opts: CollideOptions = {}): number {
  const { sizeMultiplier = 1, zoom = 1, pad = 14 } = opts
  const z = zoom > 0 ? zoom : 1
  const nodeR = (agent.isMain ? NODE.radiusMain : NODE.radiusSub) * (agent.scale ?? 1) * sizeMultiplier
  const labelHalfWorld = (opts.labelHalfWidthPx ?? TYPICAL_LABEL_HALF_WIDTH_PX) / z
  const horizontal = Math.max(nodeR + pad, labelHalfWorld + 8)
  const verticalAllowance = (LABEL_STACK_HEIGHT_PX / 2) / z
  return Math.round(horizontal + verticalAllowance)
}

export interface SuggestedForces {
  chargeStrength: number
  linkDistance: number
  collideRadius: number
}

/**
 * Node-count-scaled force parameters. Denser graphs need more repulsion and
 * longer links so the (constant screen size) labels have room at the fit zoom.
 */
export function suggestForceParams(nodeCount: number, agent: CollideAgent = { isMain: false }): SuggestedForces {
  const n = Math.max(1, nodeCount)
  const chargeStrength = -Math.min(2600, 900 + 90 * n)
  const linkDistance = Math.min(460, 240 + 14 * n)
  // Assume a fit zoom that shrinks as the graph grows.
  const zoom = Math.max(0.55, 1 / Math.sqrt(1 + n / 4))
  return { chargeStrength, linkDistance, collideRadius: collideRadiusFor(agent, { zoom }) }
}
