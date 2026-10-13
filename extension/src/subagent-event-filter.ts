/**
 * Shared hook-event filtering policy for a session whose transcript is
 * already being parsed by a TranscriptParser (directly, in scripts/relay.ts,
 * or via SessionWatcher, in extension/src/claude-runtime.ts).
 *
 * Used by both consumers of HookServer so the policy can't silently drift
 * between the standalone relay and the VS Code extension — it already did
 * once (the sessionless-event fallback: one treated it as always-unhandled,
 * the other as handled whenever any session was active) before this was
 * extracted.
 */
import { AgentEvent } from './protocol'
import { ORCHESTRATOR_NAME } from './constants'

/** Events the transcript parser already owns end-to-end for a watched
 *  session. Letting the hook server re-emit these would create
 *  duplicate/wrongly-named nodes (hook = agent_type-id, transcript =
 *  description). */
export const SUBAGENT_LIFECYCLE_EVENTS = new Set<AgentEvent['type']>([
  'agent_spawn', 'subagent_dispatch', 'subagent_return', 'agent_complete',
])

/** Convert orchestrator agent_complete to agent_idle unless it's a session
 *  end. Prevents premature "completed" state during long API calls. */
export function filterOrchestratorCompletion(event: AgentEvent): AgentEvent | null {
  if (event.type !== 'agent_complete') return event
  const agentName = event.payload?.agent ?? event.payload?.name
  const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName
  if (!isOrchestrator) return event
  if (event.payload?.sessionEnd) return event
  return { ...event, type: 'agent_idle' }
}

/** Filter a hook-sourced event for a session the transcript parser owns.
 *  Returns null to drop the event entirely, or the (possibly transformed)
 *  event to pass through. */
export function filterHookEventForWatchedSession(event: AgentEvent): AgentEvent | null {
  const agentName = event.payload?.agent ?? event.payload?.name
  const isOrchestrator = agentName === ORCHESTRATOR_NAME || !agentName
  if (isOrchestrator) return filterOrchestratorCompletion(event)

  // Subagent lifecycle events — the transcript parser handles these (it has
  // the correct display name from the Task's description).
  if (SUBAGENT_LIFECYCLE_EVENTS.has(event.type)) return null

  // Subagent tool/message events — pass through as-is.
  return event
}
