import type { Agent, ToolCallNode } from '@/lib/agent-types'

/**
 * Cumulative per-session usage ledger.
 *
 * Totals shown in the cost card and top bar must not shrink when a finished
 * sub-agent fades out of the graph, expires from the hidden-agents map, or a
 * tool call card is pruned. The ledger therefore only ever grows:
 *  - agents: one entry per agent id holding the peak tokensUsed seen (tokensUsed
 *    is a context-size snapshot, not a delta stream, so overwrite-with-max is
 *    idempotent against replays and resumes of the same id) plus the latest model;
 *  - tools: one entry per tool-call id holding its largest tokenCost, so the
 *    per-tool breakdown survives card removal.
 *
 * The maps are mutated in place and the wrapper object is replaced when anything
 * changed, so reference equality still signals "ledger changed" to React.
 * It is reset only by creating a new one (a real session reset / replay).
 */
export interface LedgerAgent {
  name: string
  isMain: boolean
  model?: string
  tokens: number
}

export interface LedgerTool {
  toolName: string
  agentId: string
  tokens: number
}

export interface UsageLedger {
  agents: Map<string, LedgerAgent>
  tools: Map<string, LedgerTool>
}

export function createUsageLedger(): UsageLedger {
  return { agents: new Map(), tools: new Map() }
}

/** Fold the current agents (+ optional tool calls) into the ledger. Returns the same
 *  ledger object when nothing grew, else a new wrapper sharing the same maps. */
export function recordUsage(
  ledger: UsageLedger,
  agents: ReadonlyMap<string, Agent>,
  toolCalls?: ReadonlyMap<string, ToolCallNode>,
): UsageLedger {
  let changed = false
  for (const [id, a] of agents) {
    if (!(a.tokensUsed > 0)) continue
    const prev = ledger.agents.get(id)
    if (!prev) {
      ledger.agents.set(id, { name: a.name, isMain: a.isMain, model: a.model, tokens: a.tokensUsed })
      changed = true
    } else if (a.tokensUsed > prev.tokens || (a.model && a.model !== prev.model)) {
      prev.tokens = Math.max(prev.tokens, a.tokensUsed)
      if (a.model) prev.model = a.model
      changed = true
    }
  }
  if (toolCalls) {
    for (const [id, tc] of toolCalls) {
      if (!(tc.tokenCost && tc.tokenCost > 0)) continue
      const prev = ledger.tools.get(id)
      if (!prev) {
        ledger.tools.set(id, { toolName: tc.toolName, agentId: tc.agentId, tokens: tc.tokenCost })
        changed = true
      } else if (tc.tokenCost > prev.tokens) {
        prev.tokens = tc.tokenCost
        changed = true
      }
    }
  }
  return changed ? { agents: ledger.agents, tools: ledger.tools } : ledger
}

/** Total tokens across every agent ever recorded. */
export function ledgerTotalTokens(ledger: UsageLedger): number {
  let sum = 0
  for (const e of ledger.agents.values()) sum += e.tokens
  return sum
}
