/**
 * Context-window accounting for Claude Code transcripts.
 *
 * Every assistant transcript line carries `message.usage`, which is the
 * authoritative size of the context the model saw on that turn. The text
 * estimates in `session.contextBreakdown` only ever grow (they count
 * everything ever said and never shrink on compaction), so they are used for
 * the category *proportions* only and rescaled to the authoritative total.
 */

import type { WatchedSession } from './protocol'

export interface ContextPayload {
  tokens: number
  breakdown: WatchedSession['contextBreakdown']
  /** True when `tokens` comes from transcript `usage` rather than estimates. */
  isAuthoritative?: true
}

/** Current context size implied by an assistant message's `usage` block, or
 *  undefined when absent / zero (e.g. `<synthetic>` messages). */
export function contextTokensFromUsage(usage: unknown): number | undefined {
  if (!usage || typeof usage !== 'object') return undefined
  const u = usage as Record<string, unknown>
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const total = n(u.input_tokens) + n(u.cache_creation_input_tokens) + n(u.cache_read_input_tokens) + n(u.output_tokens)
  return total > 0 ? total : undefined
}

/** Record the latest usage for an agent. Returns true if it was usable. */
export function recordContextUsage(session: WatchedSession, agentName: string, usage: unknown): boolean {
  const tokens = contextTokensFromUsage(usage)
  if (tokens === undefined) return false
  if (!session.contextUsage) session.contextUsage = new Map()
  session.contextUsage.set(agentName, tokens)
  return true
}

/** Compaction: drop accumulated estimates (keeping the fixed system prompt) and
 *  forget the agent's stale usage until its next assistant message. */
export function resetContextForCompaction(session: WatchedSession, agentName: string): void {
  const bd = session.contextBreakdown
  bd.userMessages = 0
  bd.toolResults = 0
  bd.reasoning = 0
  bd.subagentResults = 0
  session.contextUsage?.delete(agentName)
}

/** Build the context_update payload for an agent. */
export function buildContextPayload(session: WatchedSession, agentName: string): ContextPayload {
  const bd = session.contextBreakdown
  const estimated = bd.systemPrompt + bd.userMessages + bd.toolResults + bd.reasoning + bd.subagentResults
  const actual = session.contextUsage?.get(agentName)
  if (actual === undefined) return { tokens: estimated, breakdown: { ...bd } }

  const keys = ['systemPrompt', 'userMessages', 'toolResults', 'reasoning', 'subagentResults'] as const
  const scaled = { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 }
  if (estimated <= 0) {
    scaled.systemPrompt = actual
  } else {
    let sum = 0
    let largest: (typeof keys)[number] = keys[0]
    for (const k of keys) {
      scaled[k] = Math.floor((bd[k] / estimated) * actual)
      sum += scaled[k]
      if (bd[k] > bd[largest]) largest = k
    }
    scaled[largest] += actual - sum // distribute rounding remainder
  }
  return { tokens: actual, breakdown: scaled, isAuthoritative: true }
}
