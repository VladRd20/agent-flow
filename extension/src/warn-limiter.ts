/** Allows one warning per key per interval (default 60 s), so a poisoned
 *  transcript cannot flood the log on every watch event. */
export class WarnLimiter {
  private last = new Map<string, number>()
  constructor(private intervalMs = 60_000) {}

  shouldWarn(key: string, now: number = Date.now()): boolean {
    const t = this.last.get(key)
    if (t !== undefined && now - t < this.intervalMs) return false
    this.last.set(key, now)
    return true
  }

  forget(key: string): void { this.last.delete(key) }
}
