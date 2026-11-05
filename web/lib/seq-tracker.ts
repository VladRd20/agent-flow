/**
 * Client-side bookkeeping for the relay's per-session event sequence numbers.
 * Events without a `seq` (VS Code webview path) are always accepted.
 */
export class SeqTracker {
  epoch: string | null = null
  private last = new Map<string, number>()

  /** Record the server's boot id. Returns true when it CHANGED from a previously
   *  known one (server restarted): cursors are cleared and the caller must drop
   *  all session state before the full replay arrives. */
  setEpoch(epoch: string): boolean {
    const changed = this.epoch !== null && this.epoch !== epoch
    this.epoch = epoch
    if (changed) this.last.clear()
    return changed
  }

  /** True if the event is new (and advances the cursor); false for a duplicate/replayed one. */
  accept(sessionId: string | undefined, seq: number | undefined): boolean {
    if (!sessionId || typeof seq !== 'number') return true
    if (seq <= (this.last.get(sessionId) ?? 0)) return false
    this.last.set(sessionId, seq)
    return true
  }

  forget(sessionId: string): void { this.last.delete(sessionId) }
  clear(): void { this.last.clear() }

  /** Query string for the next (re)connect: `epoch=...&since=sid:seq,...` or ''. */
  query(): string {
    if (this.epoch === null || this.last.size === 0) return ''
    const since = [...this.last].map(([sid, seq]) => `${sid}:${seq}`).join(',')
    return `epoch=${encodeURIComponent(this.epoch)}&since=${encodeURIComponent(since)}`
  }
}
