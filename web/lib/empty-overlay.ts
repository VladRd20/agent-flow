/** Grace before the "WAITING FOR AGENT SESSION" overlay may appear. A session switch or a
 *  new-session start empties the simulation for a moment (restart() clears the agents; the
 *  orchestrator's agent_spawn is folded on a later frame), which must not flash the overlay. */
export const EMPTY_OVERLAY_GRACE_MS = 1500

/** The overlay shows only once the canvas has been continuously empty for the grace period. */
export function shouldShowEmptyOverlay(isEmpty: boolean, emptyForMs: number, graceMs = EMPTY_OVERLAY_GRACE_MS): boolean {
  return isEmpty && emptyForMs >= graceMs
}
