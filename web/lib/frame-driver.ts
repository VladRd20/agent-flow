/**
 * Single requestAnimationFrame driver shared by the simulation step and the
 * canvas draw. Replaces two independent never-ending rAF loops.
 *
 * - Each task reports how busy it is after every tick: 'full' (animating),
 *   'slow' (subtle ambient animation: throttled to ~30fps) or 'idle'.
 *   When every task is idle the driver stops scheduling entirely (zero CPU)
 *   until something calls wake().
 * - Coarse-pointer devices (phones/tablets) are capped to 30fps.
 * - While the document is hidden rAF is not used at all; only tasks flagged
 *   runWhenHidden (the simulation, so queued events keep draining) tick on a
 *   low-rate timer.
 * - Tasks get `resumed = true` on the first tick after idle/hidden so they can
 *   reset their delta-time baseline (no giant dt jump).
 *
 * `?perf=1` enables lightweight stats and a small DOM overlay; when off the
 * only cost is a boolean check.
 */

export type FrameMode = 'full' | 'slow' | 'idle'

export interface FrameTask {
  name: string
  /** Lower runs first within a frame. */
  order: number
  /** Keep ticking (at a low rate) while the tab is hidden. */
  runWhenHidden?: boolean
  tick(timestamp: number, resumed: boolean): FrameMode
}

const FULL_INTERVAL_MS = 1000 / 60 - 1
const THROTTLED_INTERVAL_MS = 1000 / 30
const HIDDEN_INTERVAL_MS = 500
const RANK: Record<FrameMode, number> = { idle: 0, slow: 1, full: 2 }

export const PERF_STATS_ENABLED = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).get('perf') === '1'

export function isCoarsePointer(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(pointer: coarse)').matches
}

export class FrameDriver {
  private tasks: FrameTask[] = []
  private raf = 0
  private timer: ReturnType<typeof setTimeout> | 0 = 0
  private lastRun = 0
  private mode: FrameMode = 'idle'
  private resumed = true
  private coarse = false
  private listening = false
  /** True while run() is executing task ticks. */
  private running = false
  /** wake() was called during a tick; keep going even if every task reports idle. */
  private wakeRequested = false

  // perf stats (only touched when PERF_STATS_ENABLED)
  private statTicks = 0
  private statBusyMs = 0
  private statWindowStart = 0
  private statLast = { fps: 0, ms: 0, mode: 'idle' as FrameMode, idlePct: 0, perTask: {} as Record<string, number> }
  private statTaskMs: Record<string, number> = {}
  private statIdleSince = 0
  private statIdleMs = 0
  private statEl: HTMLElement | null = null

  register(task: FrameTask): () => void {
    this.tasks.push(task)
    this.tasks.sort((a, b) => a.order - b.order)
    this.ensureListeners()
    this.wake()
    return () => {
      const i = this.tasks.indexOf(task)
      if (i >= 0) this.tasks.splice(i, 1)
    }
  }

  /** Resume ticking (no-op if already running). Safe to call very often. */
  wake(): void {
    // Called from inside a task's tick (raf is already 0 there): don't fork a
    // second rAF chain — run() reschedules once at the end of the tick.
    if (this.running) { this.wakeRequested = true; return }
    if (this.raf || this.timer || this.tasks.length === 0) return
    if (this.mode === 'idle') this.resumed = true
    this.mode = 'full'
    this.schedule()
  }

  get isIdle(): boolean { return !this.raf && !this.timer }

  /** Report time spent in a sub-task (perf overlay only). */
  recordTaskMs(name: string, ms: number): void {
    this.statTaskMs[name] = (this.statTaskMs[name] ?? 0) + ms
  }

  private ensureListeners(): void {
    if (this.listening || typeof document === 'undefined') return
    this.listening = true
    this.coarse = isCoarsePointer()
    document.addEventListener('visibilitychange', () => {
      this.cancelPending()
      this.resumed = true
      this.mode = 'idle'
      this.wake()
    })
    if (typeof window.matchMedia === 'function') {
      window.matchMedia('(pointer: coarse)').addEventListener?.('change', (e) => { this.coarse = e.matches })
    }
  }

  private cancelPending(): void {
    if (this.raf) { cancelAnimationFrame(this.raf); this.raf = 0 }
    if (this.timer) { clearTimeout(this.timer); this.timer = 0 }
  }

  private schedule(): void {
    if (this.raf || this.timer) return // exactly one pending tick at a time
    if (document.hidden) {
      this.timer = setTimeout(() => this.run(performance.now()), HIDDEN_INTERVAL_MS)
    } else {
      this.raf = requestAnimationFrame(this.onRaf)
    }
  }

  private onRaf = (ts: number) => { this.raf = 0; this.run(ts) }

  private run(ts: number): void {
    this.timer = 0
    const hidden = document.hidden
    const interval = hidden ? 0
      : (this.coarse || this.mode === 'slow') ? THROTTLED_INTERVAL_MS : FULL_INTERVAL_MS
    if (!this.resumed && this.lastRun && ts - this.lastRun < interval - 2) {
      this.schedule()
      return
    }
    const resumed = this.resumed
    this.resumed = false
    this.lastRun = ts

    const t0 = PERF_STATS_ENABLED ? performance.now() : 0
    let best: FrameMode = 'idle'
    this.running = true
    this.wakeRequested = false
    try {
      for (const task of this.tasks) {
        if (hidden && !task.runWhenHidden) continue
        let m: FrameMode = 'full'
        try { m = task.tick(ts, resumed) } catch (err) { console.warn(`[frame-driver] ${task.name} failed:`, err) }
        if (RANK[m] > RANK[best]) best = m
      }
    } finally {
      this.running = false
    }
    if (this.wakeRequested && best === 'idle') best = 'full'
    this.wakeRequested = false
    this.mode = best
    if (PERF_STATS_ENABLED) this.recordStats(t0, best)

    if (best === 'idle') {
      this.resumed = true // next wake is a resume
      return
    }
    this.schedule()
  }

  private recordStats(t0: number, mode: FrameMode): void {
    const now = performance.now()
    this.statTicks++
    this.statBusyMs += now - t0
    if (!this.statWindowStart) this.statWindowStart = now
    if (mode === 'idle') { if (!this.statIdleSince) this.statIdleSince = now }
    else if (this.statIdleSince) { this.statIdleMs += now - this.statIdleSince; this.statIdleSince = 0 }
    const win = now - this.statWindowStart
    if (win < 1000) return
    const idleNow = this.statIdleSince ? now - this.statIdleSince : 0
    this.statLast = {
      fps: Math.round(this.statTicks * 1000 / win),
      ms: this.statTicks ? this.statBusyMs / this.statTicks : 0,
      mode,
      idlePct: Math.round(100 * Math.min(1, (this.statIdleMs + idleNow) / win)),
      perTask: Object.fromEntries(Object.entries(this.statTaskMs).map(([k, v]) => [k, v / Math.max(1, this.statTicks)])),
    }
    this.statTicks = 0; this.statBusyMs = 0; this.statWindowStart = now; this.statIdleMs = 0
    if (this.statIdleSince) this.statIdleSince = now
    this.statTaskMs = {}
    this.renderStats()
  }

  private renderStats(): void {
    if (!this.statEl) {
      const el = document.createElement('pre')
      el.style.cssText = 'position:fixed;left:6px;bottom:6px;z-index:99999;margin:0;padding:4px 6px;'
        + 'font:10px/1.3 monospace;color:#9f9;background:rgba(0,0,0,.65);pointer-events:none;border-radius:4px'
      document.body.appendChild(el)
      this.statEl = el
    }
    const s = this.statLast
    const tasks = Object.entries(s.perTask).map(([k, v]) => `${k} ${v.toFixed(1)}ms`).join('  ')
    this.statEl.textContent =
      `fps ${s.fps}  tick ${s.ms.toFixed(1)}ms  mode ${s.mode}  idle ${s.idlePct}%\n${tasks}`
  }
}

export const frameDriver = new FrameDriver()

/** Wake the shared frame driver (new data, input, resize, panel change). */
export function wakeFrames(): void { frameDriver.wake() }

/** Max canvas backing-store scale. dpr 3 phones render 2.25x the pixels of dpr 2
 *  for no visible gain on this kind of vector/glow art, and bloom/compositing
 *  cost scales with pixel count. */
export const MAX_CANVAS_DPR = 2

export function cappedDpr(): number {
  const raw = (typeof window !== 'undefined' && window.devicePixelRatio) || 1
  return Math.min(raw, MAX_CANVAS_DPR)
}
