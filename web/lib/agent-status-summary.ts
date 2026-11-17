import type { AgentState } from '@/lib/agent-types'

export interface AgentStatusSummary {
  /** thinking or running a tool */
  active: number
  /** blocked on a permission prompt */
  waiting: number
  error: number
  /** First agent waiting on a permission prompt (Map iteration order), for jump-to */
  firstWaitingId: string | null
}

export const EMPTY_STATUS_SUMMARY: AgentStatusSummary = { active: 0, waiting: 0, error: 0, firstWaitingId: null }

export function summarizeAgentStates(agents: ReadonlyMap<string, { state: AgentState }>): AgentStatusSummary {
  let active = 0
  let waiting = 0
  let error = 0
  let firstWaitingId: string | null = null
  for (const [id, a] of agents) {
    if (a.state === 'thinking' || a.state === 'tool_calling') active++
    else if (a.state === 'waiting_permission') { waiting++; if (firstWaitingId === null) firstWaitingId = id }
    else if (a.state === 'error') error++
  }
  return { active, waiting, error, firstWaitingId }
}
