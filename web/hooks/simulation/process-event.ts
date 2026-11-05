import {
  Agent,
  ToolCallNode,
  Edge,
  SimulationEvent,
  type TimelineEntry,
  type TimelineBlock,
} from '@/lib/agent-types'
import type { SimulationState, ConversationMessage } from './types'
import { handleAgentSpawn, handleAgentComplete, handleAgentIdle, handlePermissionRequested, handleModelDetected } from './handle-agent-events'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import { handleMessage, handleContextUpdate } from './handle-message-events'
import { handleSubagentDispatch, handleSubagentReturn } from './handle-subagent-events'
import { reviveHiddenAgent } from './hidden-agents'

export interface ProcessEventContext {
  syncForceSimulation: (agents: Map<string, Agent>, edges: Edge[]) => void
  findToolSlot: (agent: Agent, agents: Map<string, Agent>, toolCalls: Map<string, ToolCallNode>, currentTime: number) => { x: number; y: number }
  getContextWindowSize: (modelId?: string) => number
  blockIdCounter: { current: number }
  skipForceSync: boolean
}

/** Mutable collections that handlers mutate in place during a single processEvent call. */
export interface MutableEventState {
  agents: Map<string, Agent>
  toolCalls: Map<string, ToolCallNode>
  particles: SimulationState['particles']
  edges: Edge[]
  discoveries: SimulationState['discoveries']
  fileAttention: SimulationState['fileAttention']
  timelineEntries: SimulationState['timelineEntries']
  conversations: Map<string, ConversationMessage[]>
  hiddenAgents: SimulationState['hiddenAgents']
  /** When set (historical batch folds), visuals (tool cards, particles, bubbles)
   *  for events with time < visualCutoff are skipped — they would already have
   *  faded out by the end of the batch. Non-visual state is still updated. */
  visualCutoff?: number
  /** tool_use_id -> call info for tool starts whose visuals were skipped, so the
   *  matching tool_end can still attribute file-attention token cost. */
  skippedTools?: Map<string, { args: string; inputData?: Record<string, unknown> }>
}

/** Close the last open block on a timeline entry and push a new one. */
export function pushTimelineBlock(
  entry: TimelineEntry,
  currentTime: number,
  block: Pick<TimelineBlock, 'type' | 'label' | 'color'> & { endTime?: number },
  ctx: ProcessEventContext,
): void {
  const lastBlock = entry.blocks[entry.blocks.length - 1]
  if (lastBlock && !lastBlock.endTime) lastBlock.endTime = currentTime
  entry.blocks.push({
    id: `block-${ctx.blockIdCounter.current++}`,
    type: block.type,
    startTime: currentTime,
    endTime: block.endTime,
    label: block.label,
    color: block.color,
  })
}

/** Shallow-compare two Maps by reference equality of values */
function mapsEqual<K, V>(a: Map<K, V>, b: Map<K, V>): boolean {
  if (a.size !== b.size) return false
  for (const [k, v] of a) if (b.get(k) !== v) return false
  return true
}

/** Apply one event to already-copied mutable collections. */
export function applyEvent(event: SimulationEvent, currentTime: number, state: MutableEventState, ctx: ProcessEventContext): void {
  // A new tool call is unambiguous activity: a finished sub-agent making one has
  // been resumed (some resume paths never re-send agent_spawn). Bring it back.
  if (event.type === 'tool_call_start') {
    const name = typeof event.payload.agent === 'string' ? event.payload.agent : ''
    const agent = state.agents.get(name)
    if (agent) {
      if (agent.state === 'complete' && !agent.isMain) {
        state.agents.set(name, { ...agent, state: 'idle', completeTime: undefined })
      }
    } else if (name) {
      reviveHiddenAgent(state, name, currentTime, ctx)
    }
  }
  switch (event.type) {
    case 'agent_spawn':       handleAgentSpawn(event.payload, currentTime, state, ctx); break
    case 'agent_complete':    handleAgentComplete(event.payload, currentTime, state, ctx); break
    case 'agent_idle':        handleAgentIdle(event.payload, state); break
    case 'model_detected':    handleModelDetected(event.payload, state, ctx); break
    case 'tool_call_start':   handleToolCallStart(event.payload, currentTime, state, ctx); break
    case 'tool_call_end':     handleToolCallEnd(event.payload, currentTime, state, ctx); break
    case 'message':           handleMessage(event.payload, currentTime, state); break
    case 'context_update':    handleContextUpdate(event.payload, state); break
    case 'subagent_dispatch': handleSubagentDispatch(event.payload, currentTime, state); break
    case 'subagent_return':   handleSubagentReturn(event.payload, currentTime, state); break
    case 'permission_requested': handlePermissionRequested(event.payload, currentTime, state, ctx); break
  }
}

function copyCollections(prev: SimulationState): MutableEventState {
  return {
    agents: new Map(prev.agents),
    toolCalls: new Map(prev.toolCalls),
    particles: [...prev.particles],
    edges: [...prev.edges],
    discoveries: [...prev.discoveries],
    fileAttention: new Map(prev.fileAttention),
    timelineEntries: new Map(prev.timelineEntries),
    conversations: new Map(prev.conversations),
    hiddenAgents: new Map(prev.hiddenAgents),
  }
}

function withCollections(prev: SimulationState, state: MutableEventState): SimulationState {
  // Stabilize references for unchanged collections to prevent
  // downstream React useMemo/re-render cascades (O(n log n) sorts etc.)
  return {
    ...prev,
    agents: state.agents, toolCalls: state.toolCalls,
    particles: state.particles, edges: state.edges,
    discoveries: state.discoveries,
    fileAttention: mapsEqual(prev.fileAttention, state.fileAttention) ? prev.fileAttention : state.fileAttention,
    timelineEntries: mapsEqual(prev.timelineEntries, state.timelineEntries) ? prev.timelineEntries : state.timelineEntries,
    conversations: mapsEqual(prev.conversations, state.conversations) ? prev.conversations : state.conversations,
    hiddenAgents: mapsEqual(prev.hiddenAgents, state.hiddenAgents) ? prev.hiddenAgents : state.hiddenAgents,
  }
}

export function processEvent(event: SimulationEvent, prev: SimulationState, ctx: ProcessEventContext): SimulationState {
  const state = copyCollections(prev)
  applyEvent(event, prev.currentTime, state, ctx)
  return withCollections(prev, state)
}

/** Seconds of event history that can still be visible on screen (tool cards
 *  run + fade, bubbles, particles). Events older than batchEnd minus this are
 *  folded without creating visuals. */
export const VISUAL_LIFETIME_S = 15

/** Batches smaller than this are folded with full visuals (live trickle). */
export const HISTORICAL_BATCH_MIN = 50

/**
 * Fold many events with ONE copy of the state collections (processEvent copies
 * all 8 per call, O(state) per event). `resolveTime` gives each event's
 * simulation time; the result is identical to calling processEvent one event
 * at a time with currentTime set to that time, except that purely visual
 * artifacts (tool cards/edges, particles, bubbles) older than `visualCutoff`
 * are skipped. Returns the new state plus the time-stamped events applied.
 */
export function foldEvents(
  events: readonly SimulationEvent[],
  prev: SimulationState,
  ctx: ProcessEventContext,
  opts: {
    resolveTime: (event: SimulationEvent) => number
    visualCutoff?: number
    /** Hold ONE map across all slices of a backlog drain so a tool_end in a later
     *  slice still finds its skipped start. Defaults to a per-call map. */
    skippedTools?: Map<string, { args: string; inputData?: Record<string, unknown> }>
  },
): { state: SimulationState; applied: SimulationEvent[] } {
  if (events.length === 0) return { state: prev, applied: [] }
  const state = copyCollections(prev)
  state.visualCutoff = opts.visualCutoff
  state.skippedTools = opts.skippedTools ?? new Map()
  const applied: SimulationEvent[] = []
  let currentTime = prev.currentTime
  for (const event of events) {
    currentTime = opts.resolveTime(event)
    applyEvent(event, currentTime, state, ctx)
    applied.push({ ...event, time: currentTime })
  }
  state.visualCutoff = undefined
  state.skippedTools = undefined
  return { state: { ...withCollections(prev, state), currentTime }, applied }
}
