import { Edge } from '@/lib/agent-types'

/**
 * Click-to-focus / local graph (Obsidian-style): when a node is selected,
 * everything except that node and its directly-connected neighbors (one hop
 * via any edge, agent<->agent or agent<->tool-call) should dim. Returns null
 * when nothing is selected, meaning "no dimming — draw everything at full
 * opacity" (distinguishes "no focus" from "focus set happens to be empty").
 */
export function computeFocusSet(selectedAgentId: string | null, edges: Edge[]): Set<string> | null {
  if (!selectedAgentId) return null
  const set = new Set<string>([selectedAgentId])
  for (const e of edges) {
    if (e.from === selectedAgentId) set.add(e.to)
    else if (e.to === selectedAgentId) set.add(e.from)
  }
  return set
}
