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
  /**
   * Stable keys of messages already folded in. Message ids are NOT stable (seekToTime replays
   * the log and every message gets a fresh id), so the key is agent + timestamp + index among
   * that agent's messages sharing the timestamp: the same replayed event maps to the same key.
   */
  seen: Set<string>
  /** Sorted by timestamp, capped at `cap`. */
  events: TimelineEvent[]
  idCounter: number
  cap: number
}

export function createTimelineCache(cap = MAX_TIMELINE_EVENTS): TimelineCache {
  return { seen: new Set(), events: [], idCounter: 0, cap }
}

/** Keys that survive a replay: `${agent}|${timestamp}|${nth message at that timestamp}`. */
export function messageKeys(agentId: string, msgs: readonly { timestamp: number }[]): string[] {
  const keys: string[] = new Array(msgs.length)
  let prevTs = NaN
  let n = 0
  for (let i = 0; i < msgs.length; i++) {
    const ts = msgs[i].timestamp
    n = ts === prevTs ? n + 1 : 0
    prevTs = ts
    keys[i] = `${agentId}|${ts}|${n}`
  }
  return keys
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
    const keys = messageKeys(agentId, msgs)
    for (let i = 0; i < msgs.length; i++) {
      if (cache.seen.has(keys[i])) continue
      cache.seen.add(keys[i])
      const msg = msgs[i]
      insertSorted(cache.events, {
        id: `event-${cache.idCounter++}`,
        type: msg.type === 'tool_call' ? 'tool_call' : msg.type === 'tool_result' ? 'tool_result' : 'message',
        label: msg.content.slice(0, 20),
        timestamp: msg.timestamp,
        nodeId: agentId,
      })
      changed = true
    }
  }
  if (cache.events.length > cache.cap) cache.events.splice(0, cache.events.length - cache.cap)
  // Bound the key set (insertion order = oldest first) so hours of traffic cannot grow it forever
  const seenCap = cache.cap * 10
  if (cache.seen.size > seenCap) {
    let drop = cache.seen.size - seenCap
    for (const k of cache.seen) { if (drop-- <= 0) break; cache.seen.delete(k) }
  }
  return changed
}
