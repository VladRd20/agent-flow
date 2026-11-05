import type { Agent, Edge } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { edgeId } from './types'
import { pushTimelineBlock, type MutableEventState, type ProcessEventContext } from './process-event'

/**
 * Finished sub-agents are not deleted when their fade-out ends: they move to a
 * hidden map (out of the graph, physics, hit-testing and counts) so a resumed
 * agent (SendMessage, a re-run Workflow) comes back with its stats instead of as
 * a blank new node. A node hidden longer than HIDDEN_AGENT_TTL_S is dropped.
 */
export const HIDDEN_AGENT_TTL_S = 15 * 60

export interface HiddenAgent {
  agent: Agent
  /** Simulation time the node was hidden */
  hiddenAt: number
}

export type HiddenAgents = Map<string, HiddenAgent>

/** Drop hidden nodes older than the TTL. Returns the same map when nothing expired. */
export function purgeExpiredHidden(hidden: HiddenAgents, now: number): HiddenAgents {
  let out = hidden
  for (const [id, h] of hidden) {
    if (now - h.hiddenAt >= HIDDEN_AGENT_TTL_S) {
      if (out === hidden) out = new Map(hidden)
      out.delete(id)
    }
  }
  return out
}

/**
 * Bring a hidden agent back into the graph (mutates `state`). Returns false when
 * `name` isn't hidden. Parent/child edges are rebuilt from parentId, so it
 * doesn't matter which side of a pair was hidden or revived first.
 */
export function reviveHiddenAgent(
  state: MutableEventState, name: string, currentTime: number, ctx: ProcessEventContext,
  overrides: Partial<Agent> = {},
): boolean {
  const hidden = state.hiddenAgents.get(name)
  if (!hidden) return false
  state.hiddenAgents.delete(name)

  const agent: Agent = {
    ...hidden.agent,
    state: 'idle',
    completeTime: undefined,
    currentTool: undefined,
    opacity: 0,
    scale: 0.3,
    vx: 0, vy: 0,
    messageBubbles: [],
    ...overrides,
  }
  state.agents.set(name, agent)

  const hasEdge = (id: string) => state.edges.some(e => e.id === id)
  const addEdge = (from: string, to: string) => {
    const id = edgeId(from, to)
    if (!hasEdge(id)) state.edges.push({ id, from, to, type: 'parent-child', opacity: 0 } satisfies Edge)
  }
  if (agent.parentId && state.agents.has(agent.parentId)) addEdge(agent.parentId, name)
  for (const [childId, child] of state.agents) {
    if (child.parentId === name) addEdge(name, childId)
  }

  const entry = state.timelineEntries.get(name)
  if (entry) {
    const updated = { ...entry, blocks: [...entry.blocks], endTime: undefined }
    pushTimelineBlock(updated, currentTime, { type: 'idle', label: 'Resumed', color: COLORS.idle }, ctx)
    state.timelineEntries.set(name, updated)
  }

  if (!ctx.skipForceSync) {
    setTimeout(() => ctx.syncForceSimulation(state.agents, state.edges), 0)
  }
  return true
}
