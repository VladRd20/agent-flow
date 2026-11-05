/**
 * Per-session replay buffer with front trimming that keeps index-based
 * cursors valid. Callers bookmark an ABSOLUTE position (`end` at save time);
 * `base` counts how many events were trimmed off the front, so
 * `sliceFrom(absolute)` stays correct however many trims happened since.
 * Trimming is amortized: it only happens once the buffer exceeds `max + slack`.
 */
export class SessionEventBuffer<T> {
  readonly events: T[] = []
  /** Number of events trimmed from the front so far. */
  base = 0

  constructor(private readonly max: number, private readonly slack = Math.max(1, Math.floor(max / 10))) {}

  push(event: T): void {
    this.events.push(event)
    if (this.events.length > this.max + this.slack) {
      const drop = this.events.length - this.max
      this.events.splice(0, drop)
      this.base += drop
    }
  }

  /** Absolute count of events ever pushed (the bookmark for "everything so far"). */
  get end(): number {
    return this.base + this.events.length
  }

  /** Events at absolute position >= `from` (clamped to what is still retained). */
  sliceFrom(from: number): T[] {
    return this.events.slice(Math.max(0, from - this.base))
  }
}
