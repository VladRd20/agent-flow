/** Reconnect schedule: 1 s, 2 s, 4 s ... capped at 30 s, with +/-20% jitter. */
export const BACKOFF_BASE_MS = 1000
export const BACKOFF_MAX_MS = 30000
export const BACKOFF_JITTER = 0.2

/** Un-jittered delay for the given zero-based attempt number. */
export function backoffBaseDelay(attempt: number): number {
  const n = Math.max(0, Math.floor(attempt))
  // Clamp the exponent first so large attempt counts cannot overflow
  return Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(n, 16))
}

/** Jittered delay. `rand` returns [0, 1) and is injectable for tests. */
export function backoffDelay(attempt: number, rand: () => number = Math.random): number {
  const base = backoffBaseDelay(attempt)
  const factor = 1 + (rand() * 2 - 1) * BACKOFF_JITTER
  return Math.round(base * factor)
}
