import { Edge } from '@/lib/agent-types'
import { NODE_SIZE } from '@/lib/canvas-constants'

/**
 * Obsidian-style node sizing: nodes with more connections read as more
 * prominent (an orchestrator with many subagents/tool calls should look
 * busier/bigger than a quiet leaf node). Counts every edge endpoint — both
 * parent-child and tool edges — once per frame; cheap enough to recompute
 * on every edges-array change (same pattern as buildEdgeMap/getActiveEdgeIds).
 */
export function computeDegreeMap(edges: Edge[]): Map<string, number> {
  const map = new Map<string, number>()
  for (const edge of edges) {
    map.set(edge.from, (map.get(edge.from) ?? 0) + 1)
    map.set(edge.to, (map.get(edge.to) ?? 0) + 1)
  }
  return map
}

/** Size multiplier for a node given its degree map — multiply this into the
 *  node's base radius (NODE.radiusMain / NODE.radiusSub). Capped so a very
 *  busy node can't dwarf the rest of the graph. */
export function getNodeSizeMultiplier(agentId: string, degreeMap: Map<string, number>): number {
  const degree = degreeMap.get(agentId) ?? 0
  return Math.min(NODE_SIZE.maxMultiplier, 1 + degree * NODE_SIZE.growthPerEdge)
}
