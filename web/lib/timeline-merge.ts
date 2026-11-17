import type { TimelineEvent } from '@/lib/agent-types'

/** Most recent timeline events kept for the scrubber markers. */
export const MAX_TIMELINE_EVENTS = 2000

export interface TimelineMessage {
  id: string
  type: string
  content: string
  timestamp: number
}

export interface TimelineCache {
  /** Last message id folded in, per agent (identity, not array length: conversations are capped). */
  lastSeen: Map<string, string>
  /** Sorted by timestamp, capped at `cap`. */
  events: TimelineEvent[]
  idCounter: number
  cap: number
}

export function createTimelineCache(cap = MAX_TIMELINE_EVENTS): TimelineCache {
  return { lastSeen: new Map(), events: [], idCounter: 0, cap }
}

/** Messages after the last one already seen (all of them when it has rolled off the capped array). */
export function newMessages<T extends { id: string }>(msgs: readonly T[], lastSeenId: string | undefined): readonly T[] {
  if (msgs.length === 0 || lastSeenId === undefined) return msgs
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].id === lastSeenId) return msgs.slice(i + 1)
  }
  return msgs
}

function insertSorted(events: TimelineEvent[], ev: TimelineEvent): void {
  const last = events[events.length - 1]
  if (!last || ev.timestamp >= last.timestamp) { events.push(ev); return }
  // upper bound: keep insertion order stable among equal timestamps
  let lo = 0
  let hi = events.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (events[mid].timestamp <= ev.timestamp) lo = mid + 1
    else hi = mid
  }
  events.splice(lo, 0, ev)
}

/** Fold new conversation messages into the cache. Returns true when events changed. */
export function mergeTimelineEvents(cache: TimelineCache, conversations: ReadonlyMap<string, readonly TimelineMessage[]>): boolean {
  let changed = false
  for (const [agentId, msgs] of conversations) {
    const fresh = newMessages(msgs, cache.lastSeen.get(agentId))
    if (fresh.length === 0) continue
    for (const msg of fresh) {
      insertSorted(cache.events, {
        id: `event-${cache.idCounter++}`,
        type: msg.type === 'tool_call' ? 'tool_call' : msg.type === 'tool_result' ? 'tool_result' : 'message',
        label: msg.content.slice(0, 20),
        timestamp: msg.timestamp,
        nodeId: agentId,
      })
    }
    cache.lastSeen.set(agentId, msgs[msgs.length - 1].id)
    changed = true
  }
  if (cache.events.length > cache.cap) cache.events.splice(0, cache.events.length - cache.cap)
  return changed
}
