import type { Agent } from '@/lib/agent-types'

/** One-shot camera command sent from the on-screen view controls to the canvas. `seq` makes repeats distinct. */
export interface ViewCommand {
  seq: number
  kind: 'zoomIn' | 'zoomOut' | 'focusNextRunning'
}

export const ZOOM_STEP = 1.3

const RUNNING_STATES = new Set(['thinking', 'tool_calling', 'waiting_permission'])

export function isRunningState(state: string): boolean {
  return RUNNING_STATES.has(state)
}

/** Next running agent after `afterId` in map order (wrapping); the first running agent when `afterId`
 *  is null or no longer running. Null when nothing is running. */
export function nextRunningAgentId(agents: ReadonlyMap<string, Pick<Agent, 'state'>>, afterId: string | null): string | null {
  const ids: string[] = []
  for (const [id, a] of agents) if (isRunningState(a.state)) ids.push(id)
  if (ids.length === 0) return null
  const i = afterId ? ids.indexOf(afterId) : -1
  return ids[(i + 1) % ids.length]
}
