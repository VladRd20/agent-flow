/**
 * Per-session event sequencing for the SSE relay.
 *
 * Every event that belongs to a session is stamped with a monotonically
 * increasing `seq` (per session). A client remembers the last seq it saw per
 * session and reconnects with `?epoch=<bootId>&since=<sid>:<seq>,...`; the
 * server then replays only newer events. `epoch` is a random id generated at
 * server start: when it differs the seq numbers are not comparable, so the
 * client must discard its state and accept a full replay.
 */

export interface SeqEvent { seq?: number }

export class SeqAssigner {
  private counters = new Map<string, number>()

  /** Next seq for a session (1-based). */
  next(sessionId: string): number {
    const n = (this.counters.get(sessionId) ?? 0) + 1
    this.counters.set(sessionId, n)
    return n
  }

  current(sessionId: string): number {
    return this.counters.get(sessionId) ?? 0
  }
}

/** Parse `since=sid:seq,sid:seq` (sid may itself contain ':'). Invalid entries are ignored. */
export function parseSince(raw: string | null | undefined): Map<string, number> {
  const out = new Map<string, number>()
  if (!raw) return out
  for (const part of raw.split(',')) {
    const idx = part.lastIndexOf(':')
    if (idx <= 0) continue
    const seq = Number(part.slice(idx + 1))
    if (!Number.isFinite(seq) || seq < 0) continue
    out.set(part.slice(0, idx), Math.floor(seq))
  }
  return out
}

export function formatSince(since: ReadonlyMap<string, number>): string {
  return [...since].map(([sid, seq]) => `${sid}:${seq}`).join(',')
}

/** Resolve the cursor map a client is entitled to: only honoured when its epoch matches ours. */
export function resolveSince(
  query: URLSearchParams,
  bootId: string,
): Map<string, number> {
  if (query.get('epoch') !== bootId) return new Map()
  return parseSince(query.get('since'))
}

/** Index of the first event with seq > after, for a seq-ordered buffer (binary search).
 *  Events lacking a seq are treated as already delivered (never selected). */
export function firstIndexAfter(buf: ReadonlyArray<SeqEvent>, after: number): number {
  let lo = 0
  let hi = buf.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if ((buf[mid].seq ?? 0) > after) hi = mid
    else lo = mid + 1
  }
  return lo
}
