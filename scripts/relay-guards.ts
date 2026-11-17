/**
 * Small, dependency-free helpers for the relay's hot paths. Kept separate from
 * relay.ts (which holds process-wide state) so they can be unit tested.
 */

// ─── Session scan: stale-session memo ───────────────────────────────────────

/** Main transcripts older than this are never revived by subagent activity. */
export const SUBAGENT_LIVENESS_MAX_AGE_MS = 6 * 60 * 60 * 1000
/** How long a "checked, stale" verdict is trusted while the main file is unchanged. */
export const STALE_CHECK_TTL_MS = 60_000

export interface SessionScanDeps {
  /** Session ids already being watched. */
  isWatched(sessionId: string): boolean
  /** Newest mtime under the session's subagents dir (recursive stat walk — expensive). */
  newestSubagentMtime(sessionId: string): number
  now(): number
}

/** Remembers, per sessionId, that a session was walked and found stale. */
export class StaleSessionMemo {
  private entries = new Map<string, { mainMtimeMs: number; until: number }>()

  isFresh(sessionId: string, mainMtimeMs: number, now: number): boolean {
    const e = this.entries.get(sessionId)
    return !!e && e.mainMtimeMs === mainMtimeMs && e.until > now
  }

  remember(sessionId: string, mainMtimeMs: number, now: number): void {
    if (this.entries.size > 2000) {
      for (const [k, v] of this.entries) if (v.until <= now) this.entries.delete(k)
    }
    this.entries.set(sessionId, { mainMtimeMs, until: now + STALE_CHECK_TTL_MS })
  }

  forget(sessionId: string): void { this.entries.delete(sessionId) }
  get size(): number { return this.entries.size }
}

/**
 * Decide whether the scanner should start watching a session.
 * The subagent tree is walked only when the session is not yet watched, the main
 * transcript is not itself recent, is younger than SUBAGENT_LIVENESS_MAX_AGE_MS,
 * and has not already been judged stale in the last STALE_CHECK_TTL_MS.
 */
export function shouldWatchSession(
  sessionId: string,
  mainMtimeMs: number,
  activeAgeS: number,
  memo: StaleSessionMemo,
  deps: SessionScanDeps,
): boolean {
  if (deps.isWatched(sessionId)) return false
  const now = deps.now()
  const mainAgeMs = now - mainMtimeMs
  if (mainAgeMs / 1000 <= activeAgeS) { memo.forget(sessionId); return true }
  if (mainAgeMs > SUBAGENT_LIVENESS_MAX_AGE_MS) return false
  if (memo.isFresh(sessionId, mainMtimeMs, now)) return false
  const newest = Math.max(mainMtimeMs, deps.newestSubagentMtime(sessionId))
  if ((now - newest) / 1000 <= activeAgeS) { memo.forget(sessionId); return true }
  memo.remember(sessionId, mainMtimeMs, now)
  return false
}

// ─── Hook-only (un-watched) session buffers ─────────────────────────────────

/** Per-session event cap while a session has no transcript watcher. */
export const UNWATCHED_MAX_EVENTS = 500
/** Drop an un-watched session's buffer this long after its first buffered hook event. */
export const UNWATCHED_TTL_MS = 10 * 60 * 1000

/**
 * Tracks sessionIds whose events come only from hooks (no transcript watcher).
 * Replay only walks watched sessions, so those buffers can never be delivered;
 * they are capped and expire unless the session becomes watched first.
 */
export class UnwatchedTracker {
  private since = new Map<string, number>()

  /** Call when buffering a hook event for a session that is not watched. */
  touch(sessionId: string, now: number): void {
    if (!this.since.has(sessionId)) this.since.set(sessionId, now)
  }

  isTracked(sessionId: string): boolean { return this.since.has(sessionId) }

  /** Trim an un-watched buffer to the cap, keeping the newest events. */
  static cap<T>(buf: T[]): void {
    if (buf.length > UNWATCHED_MAX_EVENTS) buf.splice(0, buf.length - UNWATCHED_MAX_EVENTS)
  }

  /**
   * Returns ids whose buffers must be dropped (expired and still not watched).
   * Ids that became watched are simply untracked (their buffer is kept).
   */
  sweep(now: number, isWatched: (sessionId: string) => boolean): string[] {
    const expired: string[] = []
    for (const [sid, t] of this.since) {
      if (isWatched(sid)) { this.since.delete(sid); continue }
      if (now - t >= UNWATCHED_TTL_MS) { this.since.delete(sid); expired.push(sid) }
    }
    return expired
  }

  get size(): number { return this.since.size }
}

/**
 * Drop the event buffers of expired un-watched sessions. Only the buffer goes:
 * seq counters are never reset or lowered within one relay epoch, because
 * clients reject any event whose seq is not above the last one they saw.
 */
export function dropExpiredUnwatched<T>(
  tracker: UnwatchedTracker,
  buffers: Map<string, T[]>,
  now: number,
  isWatched: (sessionId: string) => boolean,
): string[] {
  const dropped = tracker.sweep(now, isWatched)
  for (const sid of dropped) buffers.delete(sid)
  return dropped
}

export { WarnLimiter } from '../extension/src/warn-limiter'
