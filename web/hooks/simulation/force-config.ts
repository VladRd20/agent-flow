import type { Agent, Edge } from '@/lib/agent-types'
import { collideRadiusFor, suggestForceParams } from '@/components/agent-visualizer/canvas/layout-metrics'
import { computeForceTargets, type ForceTarget } from './main-anchors'
import { computeDegreeMap, getNodeSizeMultiplier } from '@/components/agent-visualizer/canvas/node-size'

export interface ForceConfig {
  chargeStrength: number
  linkDistance: number
  /** Per-node collide radius (world px), keyed by agent id. */
  radii: Map<string, number>
  fallbackRadius: number
  /** Per-node pull toward its session's cell; empty unless 2+ mains exist (All view). */
  targets: Map<string, ForceTarget>
}

/**
 * Node-count-scaled force parameters plus a per-node collide radius that
 * accounts for degree-based node size and label room. Zoom is a fixed function
 * of node count (never the live camera zoom) so layout does not re-heat as the
 * user pinches/zooms. Uses scale 1 so fade-out scaling does not move nodes.
 */
export function buildForceConfig(agents: Map<string, Agent>, edges: Edge[]): ForceConfig {
  const n = agents.size
  const suggested = suggestForceParams(n)
  const zoom = Math.max(0.55, 1 / Math.sqrt(1 + n / 4))
  const degree = computeDegreeMap(edges)
  const radii = new Map<string, number>()
  for (const a of agents.values()) {
    radii.set(a.id, collideRadiusFor(
      { isMain: a.isMain, scale: 1 },
      { sizeMultiplier: getNodeSizeMultiplier(a.id, degree), zoom },
    ))
  }
  return {
    chargeStrength: suggested.chargeStrength,
    linkDistance: suggested.linkDistance,
    radii,
    fallbackRadius: suggested.collideRadius,
    targets: computeForceTargets(agents.values()),
  }
}
