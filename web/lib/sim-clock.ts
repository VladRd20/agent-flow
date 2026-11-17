import { useSyncExternalStore } from 'react'

export interface ClockSnapshot {
  currentTime: number
  maxTimeReached: number
}

/**
 * Tiny external store for the simulation clock. While the frame driver is idle the clock
 * advances once a second; publishing here wakes only the components that display time
 * (control bar, timeline panel) instead of re-rendering the whole visualizer root.
 */
export interface SimClock {
  subscribe: (listener: () => void) => () => void
  getSnapshot: () => ClockSnapshot
  /** Publish a new reading; no-op (no new snapshot object, no notification) when unchanged. */
  publish: (currentTime: number, maxTimeReached: number) => void
}

export function createSimClock(initial: ClockSnapshot = { currentTime: 0, maxTimeReached: 0 }): SimClock {
  let snap = initial
  const listeners = new Set<() => void>()
  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    getSnapshot: () => snap,
    publish(currentTime, maxTimeReached) {
      if (snap.currentTime === currentTime && snap.maxTimeReached === maxTimeReached) return
      snap = { currentTime, maxTimeReached }
      for (const l of [...listeners]) l()
    },
  }
}

const noopSubscribe = () => () => {}

/** Read the clock. With enabled=false the component does not subscribe (value refreshes only on its own renders). */
export function useSimClock(clock: SimClock, enabled = true): ClockSnapshot {
  return useSyncExternalStore(enabled ? clock.subscribe : noopSubscribe, clock.getSnapshot, clock.getSnapshot)
}

/** Longest gap one idle tick advances the clock while the tab stayed visible. */
export const IDLE_TICK_MAX_S = 60

/**
 * Seconds the idle clock advances for one tick. The first tick after the tab was hidden
 * advances by the full elapsed time (no cap), so the readout is not left behind; ordinary
 * ticks keep the cap as a guard against timer stalls.
 */
export function idleTickDelta(elapsedMs: number, resumedFromHidden: boolean): number {
  const s = Math.max(0, elapsedMs) / 1000
  return resumedFromHidden ? s : Math.min(s, IDLE_TICK_MAX_S)
}
