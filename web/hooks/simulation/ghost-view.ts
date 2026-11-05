import type { Agent, Edge } from '@/lib/agent-types'
import { edgeId } from './types'
import type { HiddenAgents } from './hidden-agents'

/** Draw alpha of a finished ("ghost") node and its edge in the Show finished view */
export const GHOST_ALPHA = 0.35

export interface GhostView {
  agents: Map<string, Agent>
  edges: Edge[]
}

/**
 * Derived, read-only view that overlays hidden (finished, not yet expired)
 * agents on the live graph as dimmed, motionless ghosts. Nothing here touches
 * simulation state: a real resume still goes through reviveHiddenAgent, which
 * moves the agent from `hidden` back into `agents`, at which point it is simply
 * no longer a ghost.
 *
 * Returns the inputs unchanged (same identities) when there is nothing to add.
 */
export function buildGhostView(agents: Map<string, Agent>, edges: Edge[], hidden: HiddenAgents): GhostView {
  if (hidden.size === 0) return { agents, edges }

  const merged = new Map(agents)
  for (const [id, h] of hidden) {
    if (merged.has(id)) continue // a live node with the same name wins
    merged.set(id, {
      ...h.agent,
      ghost: true,
      state: 'complete',
      currentTool: undefined,
      opacity: GHOST_ALPHA,
      scale: 1,
      vx: 0, vy: 0,
      pinned: true,
      messageBubbles: [],
    })
  }
  if (merged.size === agents.size) return { agents, edges }

  const have = new Set(edges.map(e => e.id))
  const extra: Edge[] = []
  for (const [id, agent] of merged) {
    // Only edges touching a ghost; live-live edges already exist in `edges`
    if (!agent.parentId || !merged.has(agent.parentId)) continue
    if (!agent.ghost && !merged.get(agent.parentId)!.ghost) continue
    const eid = edgeId(agent.parentId, id)
    if (have.has(eid)) continue
    have.add(eid)
    extra.push({ id: eid, from: agent.parentId, to: id, type: 'parent-child', opacity: GHOST_ALPHA })
  }
  return { agents: merged, edges: extra.length ? [...edges, ...extra] : edges }
}

/** Single-slot memo of buildGhostView keyed on input identities (for the per-frame draw loop). */
export function createGhostViewMemo() {
  let a: Map<string, Agent> | null = null
  let e: Edge[] | null = null
  let h: HiddenAgents | null = null
  let out: GhostView | null = null
  return (agents: Map<string, Agent>, edges: Edge[], hidden: HiddenAgents): GhostView => {
    if (out && a === agents && e === edges && h === hidden) return out
    a = agents; e = edges; h = hidden
    out = buildGhostView(agents, edges, hidden)
    return out
  }
}
