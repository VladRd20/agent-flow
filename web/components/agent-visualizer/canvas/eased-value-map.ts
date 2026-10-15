/**
 * Generic per-id "approach the target" easing, used for anything that
 * currently snaps straight to a new value the instant its driving state
 * changes — focus/hover dim alpha, degree-based node-size multiplier, etc.
 *
 * This uses the same style as the agent opacity/scale fades in
 * `simulation/animate.ts`: a linear per-frame approach toward a target,
 * clamped so it never overshoots (critically damped — no bounce, since
 * none of these are momentum-driven gestures). Critically, the target is
 * recomputed from current state every frame and the eased value always
 * starts from whatever is already on screen, so a second click/hover
 * mid-transition just retargets smoothly instead of snapping or restarting —
 * the interruptibility the apple-design motion principles call for.
 */
export class EasedValueMap {
  private values = new Map<string, number>()
  private touched = new Set<string>()

  /**
   * Step one id toward `target` this frame and return the eased value.
   * `seed` is the starting value used the first time an id is seen
   * (defaults to `target`, i.e. "appear already at rest").
   */
  step(id: string, target: number, rate: number, deltaTime: number, seed = target): number {
    this.touched.add(id)
    let current = this.values.get(id)
    if (current === undefined) current = seed
    if (current !== target) {
      const delta = rate * deltaTime
      current = current < target ? Math.min(target, current + delta) : Math.max(target, current - delta)
    }
    this.values.set(id, current)
    return current
  }

  /**
   * Drop ids that weren't `step()`-ed this frame (the agent/edge/tool call
   * was removed) so the map doesn't grow unbounded over a long session.
   * Call once per frame after all `step()` calls.
   */
  sweep(): void {
    if (this.touched.size !== this.values.size) {
      for (const id of this.values.keys()) {
        if (!this.touched.has(id)) this.values.delete(id)
      }
    }
    this.touched.clear()
  }
}

/** Shared easing inputs threaded through the draw-* functions. */
export interface EaseContext {
  dimMap: EasedValueMap
  sizeMap?: EasedValueMap
  /** Dim-alpha ease rate (opacity units/sec) — already scaled up for
   *  prefers-reduced-motion by the caller. */
  rate: number
  /** Size-multiplier ease rate (units/sec), used only when sizeMap is set.
   *  Defaults to `rate` if omitted. */
  sizeRate?: number
  deltaTime: number
}
