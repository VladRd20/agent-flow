import { useCallback, useEffect, useRef, useState, type MutableRefObject } from 'react'
import { wakeFrames } from '@/lib/frame-driver'
import { prefersReducedMotion } from '@/lib/reduced-motion'
import {
  AUTO_FREEZE_DELAY_MS, THAW_MS, isLayoutFrozen, readFreezePref, writeFreezePref,
  type FreezeState,
} from '@/lib/layout-freeze'

interface Options {
  /** Shared state object (created by the owner so the simulation can read it before this hook runs) */
  stateRef: MutableRefObject<FreezeState>
  isMobile: boolean
  agentCount: number
  /** Changes when the user switches session (tab) */
  sessionKey: string | null
}

/**
 * Freeze-layout controller. `stateRef` is read by the simulation and draw loops; `frozen` drives the toggle UI.
 * Default ON only with prefers-reduced-motion; on phones the layout auto-freezes once it has settled, and
 * any new node or session switch lets it run briefly again.
 */
export function useLayoutFreeze({ stateRef, isMobile, agentCount, sessionKey }: Options) {
  const [frozen, setFrozen] = useState(false)

  // Load the saved choice after mount (localStorage is not available during SSR)
  useEffect(() => {
    const user = readFreezePref(prefersReducedMotion())
    stateRef.current.user = user
    if (user) setFrozen(true)
  }, [stateRef])

  const toggle = useCallback(() => {
    const s = stateRef.current
    const effective = s.user || s.auto
    s.user = !effective
    s.auto = false
    s.thawUntil = 0
    writeFreezePref(s.user)
    setFrozen(s.user)
    wakeFrames()
  }, [stateRef])

  // Brief thaw on node add / session switch so new nodes can find their place
  const prevCount = useRef(0)
  const prevSession = useRef<string | null>(sessionKey)
  useEffect(() => {
    const added = agentCount > prevCount.current
    const switched = sessionKey !== prevSession.current
    prevCount.current = agentCount
    prevSession.current = sessionKey
    if (!added && !switched) return
    const s = stateRef.current
    s.thawUntil = performance.now() + THAW_MS
    if (s.auto) { s.auto = false; setFrozen(s.user) }
    wakeFrames()
  }, [agentCount, sessionKey, stateRef])

  // Phones: auto-freeze once nothing has been added or switched for a while
  useEffect(() => {
    if (!isMobile) {
      if (stateRef.current.auto) { stateRef.current.auto = false; setFrozen(stateRef.current.user) }
      return
    }
    const t = setTimeout(() => {
      stateRef.current.auto = true
      setFrozen(true)
    }, AUTO_FREEZE_DELAY_MS)
    return () => clearTimeout(t)
  }, [isMobile, agentCount, sessionKey, stateRef])

  return { stateRef, frozen, toggle, isFrozenNow: () => isLayoutFrozen(stateRef.current, performance.now()) }
}
