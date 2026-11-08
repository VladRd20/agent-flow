/**
 * "Freeze layout" state: pauses force-layout ticks only (battery on phones, calm for
 * reduced-motion users). Ambient animation (thinking pulse, tool timers, bubble fades), data and events keep flowing.
 *
 * Effective frozen = (user toggle OR phone auto-freeze) AND not inside a brief thaw window.
 * The state lives in a plain object so the rAF loops can read it without React renders.
 */
export interface FreezeState {
  /** Explicit user choice (persisted). */
  user: boolean
  /** Phone auto-freeze once the layout has settled; cleared on node add / session switch. */
  auto: boolean
  /** Timestamp (performance.now) until which the layout runs even if frozen. */
  thawUntil: number
}

export const FREEZE_STORAGE_KEY = 'agent-flow:freeze-layout'
/**
 * How long the layout runs after a node is added or the session changes. Must cover the d3 cooldown:
 * ln(alphaMin / 1) / ln(1 - alphaDecay) = ln(0.001) / ln(0.98) ~ 342 ticks ~ 5.7s at 60fps.
 */
export const THAW_MS = 6000
/** Phones: freeze this long after the last node add / session switch. */
export const AUTO_FREEZE_DELAY_MS = 5000

export function createFreezeState(): FreezeState {
  return { user: false, auto: false, thawUntil: 0 }
}

export function isLayoutFrozen(s: FreezeState, now: number): boolean {
  return (s.user || s.auto) && now >= s.thawUntil
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

function safeStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null
  }
}

/** Saved choice ('1' frozen / '0' running); without one, frozen by default only under prefers-reduced-motion. */
export function readFreezePref(reducedMotion: boolean, storage: StorageLike | null = safeStorage()): boolean {
  try {
    const v = storage?.getItem(FREEZE_STORAGE_KEY)
    if (v === '1') return true
    if (v === '0') return false
  } catch { /* storage blocked: fall through to the default */ }
  return reducedMotion
}

export function writeFreezePref(frozen: boolean, storage: StorageLike | null = safeStorage()): void {
  try {
    storage?.setItem(FREEZE_STORAGE_KEY, frozen ? '1' : '0')
  } catch { /* storage blocked or full: the choice just won't persist */ }
}
