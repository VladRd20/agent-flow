'use client'

import { useEffect, useState, useCallback, useRef } from 'react'
import { vscodeBridge, type ConnectionStatus, type AgentEvent, type SessionInfo } from '@/lib/vscode-bridge'
import { SimulationEvent } from '@/lib/agent-types'
import { SeqTracker } from '@/lib/seq-tracker'
import { SessionEventBuffer } from '@/lib/session-event-buffer'
import { wakeFrames } from '@/lib/frame-driver'
import {
  ALL_SESSIONS_ID, computeAllBase, mergeEventsByTime, readAllViewPreference, transformEventForAll, writeAllViewPreference,
} from '@/lib/all-sessions'

/** Max events kept in the per-session replay buffer (oldest are dropped).
 *  Without a cap a long-running/high-volume session grows this for the life of
 *  the page. Trimming uses SessionEventBuffer's base offset, so the absolute
 *  `fromIndex` bookmarks from getSessionEventCount() stay valid after a trim. */
const MAX_SESSION_EVENT_BUFFER = 10_000

interface BridgeHookResult {
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  /** Events received from VS Code extension, converted to SimulationEvent format */
  pendingEvents: readonly SimulationEvent[]
  /** Call after consuming events to clear the queue */
  consumeEvents: () => void
  /** Whether to show mock data (standalone mode or explicit config) */
  useMockData: boolean
  /** Whether CLAUDE_CODE_DISABLE_1M_CONTEXT=1 is set — caps context window to 200k */
  disable1MContext: boolean
  /** Open a file in the VS Code editor */
  bridgeOpenFile: (filePath: string, line?: number) => void
  /** Known sessions from the extension */
  sessions: SessionInfo[]
  /** Currently selected session ID */
  selectedSessionId: string | null
  /** Select a session to view (does not flush events — call flushSessionEvents after state swap). */
  selectSession: (sessionId: string | null) => void
  /** Flush buffered events for a session into pending. Call from useLayoutEffect after state swap. */
  flushSessionEvents: (sessionId: string, fromIndex?: number) => void
  /** Get the current event count for a session (for save/restore) */
  getSessionEventCount: (sessionId: string) => number
  /** Absolute buffer index the outgoing session had delivered to the simulation
   *  when the last switch away from it began (undelivered pending excluded).
   *  One-shot: cleared once read. undefined if no switch away from it was recorded. */
  takeSwitchCursor: (sessionId: string) => number | undefined
  /** Ref to the currently selected session ID — updated synchronously, not via React state */
  selectedSessionIdRef: React.RefObject<string | null>
  /** Session IDs that have received events while not selected */
  sessionsWithActivity: Set<string>
  /** Remove a session from the list */
  removeSession: (sessionId: string) => void
  /** Bumped when the All view must be rebuilt from the buffers (e.g. a tab was closed while in All) */
  allRebuildToken: number
  /** Re-run the All view from scratch: clears pending and blocks delivery until flushSessionEvents(ALL). */
  rebuildAll: () => void
}

/**
 * Connects the VS Code bridge to the React app.
 * When running standalone, returns useMockData=true and no events.
 * When inside VS Code, receives events and forwards control commands.
 *
 * Supports multi-session: events are buffered per-session so switching
 * sessions replays the correct event history.
 */
export function useVSCodeBridge(): BridgeHookResult {
  const [isVSCode, setIsVSCode] = useState(false)
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('disconnected')
  const [useMockData, setUseMockData] = useState(
    process.env.NEXT_PUBLIC_DEMO !== '0'
  )
  const [disable1MContext, setDisable1MContext] = useState(false)
  const pendingEventsRef = useRef<SimulationEvent[]>([])

  // Session state
  const [sessions, setSessions] = useState<SessionInfo[]>([])
  /** Synchronous mirror of `sessions` so the event handler sees labels/start times of just-announced sessions. */
  const sessionsRef = useRef<SessionInfo[]>([])
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null)
  /** Common clock origin of the All view (epoch ms), fixed when All is entered. */
  const allBaseRef = useRef<number>(Date.now())
  const [allRebuildToken, setAllRebuildToken] = useState(0)
  const selectedSessionIdRef = useRef<string | null>(null)
  const sessionEventsRef = useRef<Map<string, SessionEventBuffer<SimulationEvent>>>(new Map())
  /** Last relay seq seen per session + relay epoch, for dedupe and resume-on-reconnect. */
  const seqTrackerRef = useRef(new SeqTracker())
  /** Per-session ms timestamp of the last lastActivityTime state update (throttle gate). */
  const lastActivityTouchRef = useRef<Map<string, number>>(new Map())
  /** True while a session switch is pending (between auto-select and useLayoutEffect).
   *  Prevents the animation frame from processing events in the wrong simulation context. */
  const sessionSwitchPendingRef = useRef(false)
  const [sessionsWithActivity, setSessionsWithActivity] = useState<Set<string>>(new Set())
  /** Where the outgoing session's delivery stood when a switch began (see takeSwitchCursor). */
  const switchCursorRef = useRef<{ sessionId: string; end: number } | null>(null)
  /** Every session id this client has been told about (list or started). */
  const knownSessionIdsRef = useRef<Set<string>>(new Set())

  /** setSessions that also updates sessionsRef synchronously. */
  const applySessions = (updater: (prev: SessionInfo[]) => SessionInfo[]) => {
    const next = updater(sessionsRef.current)
    sessionsRef.current = next
    setSessions(next)
  }

  /** Transform one session's raw event for the All view using current session metadata. */
  const toAllEvent = (e: SimulationEvent): SimulationEvent => {
    const meta = sessionsRef.current.find(s => s.id === e.sessionId)
    return transformEventForAll(e, meta, allBaseRef.current)
  }

  /** Start switching the selection. Records the outgoing session's delivered
   *  cursor BEFORE pending is cleared: events still pending, or arriving before
   *  the layout effect swaps state, were never folded and must be replayed when
   *  the user comes back. Only refs are touched, so this is safe from any closure. */
  const beginSwitch = (nextId: string | null) => {
    const prev = selectedSessionIdRef.current
    if (nextId === ALL_SESSIONS_ID && prev !== ALL_SESSIONS_ID) allBaseRef.current = computeAllBase(sessionsRef.current)
    // Leaving All records no cursor: All keeps no per-session snapshot, and a
    // cursor for the '__all__' pseudo-session (or any real one) would be bogus.
    if (!sessionSwitchPendingRef.current && prev && prev !== ALL_SESSIONS_ID && prev !== nextId) {
      const end = sessionEventsRef.current.get(prev)?.end ?? 0
      switchCursorRef.current = { sessionId: prev, end: Math.max(0, end - pendingEventsRef.current.length) }
    }
    sessionSwitchPendingRef.current = true
    pendingEventsRef.current.length = 0
    selectedSessionIdRef.current = nextId
  }

  // Connect to standalone dev relay server via SSE when not in VS Code
  useEffect(() => {
    if (typeof window === 'undefined') return
    const bridge = vscodeBridge
    if (!bridge) return

    // Skip in VS Code — extension handles events via postMessage
    if (bridge.isVSCode) return

    // Connect to relay in dev mode or standalone CLI mode
    const isStandalone = process.env.AGENT_FLOW_STANDALONE === '1'
    if (!isStandalone && (process.env.NODE_ENV !== 'development' || process.env.NEXT_PUBLIC_DEMO !== '0')) return

    const relayPort = process.env.NEXT_PUBLIC_RELAY_PORT || ''
    const baseUrl = relayPort ? `http://127.0.0.1:${relayPort}/events` : '/events'
    const tracker = seqTrackerRef.current
    let es: EventSource | null = null
    let retryTimer: ReturnType<typeof setTimeout> | null = null
    let disposed = false

    // Reconnect manually (instead of relying on EventSource's built-in retry,
    // which reuses the original URL) so every reconnect carries the resume
    // cursor and the server only replays events we have not seen.
    const connect = () => {
      if (disposed) return
      if (retryTimer) { clearTimeout(retryTimer); retryTimer = null }
      es?.close()
      const query = tracker.query()
      const source = new EventSource(query ? `${baseUrl}?${query}` : baseUrl)
      es = source
      source.onopen = () => {
        setConnectionStatus('connected')
        setUseMockData(false)
      }
      source.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data)
          if (data && data.type === 'hello' && typeof data.epoch === 'string') {
            // Relay restarted: seq numbers restarted too. Drop everything
            // (buffers, selection, cursors) and accept the full replay.
            if (tracker.setEpoch(data.epoch)) {
              window.postMessage({ type: 'reset', reason: 'server-restarted' }, '*')
            }
            return
          }
          window.postMessage(data, '*')
        } catch {}
      }
      source.onerror = () => {
        setConnectionStatus('disconnected')
        source.close()
        if (!disposed && es === source && !retryTimer) retryTimer = setTimeout(connect, 3000)
      }
    }
    connect()

    // Mobile browsers suspend the stream in the background: reconnect promptly on return.
    const onVisible = () => {
      if (document.visibilityState === 'visible' && es && es.readyState === EventSource.CLOSED) connect()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      disposed = true
      if (retryTimer) clearTimeout(retryTimer)
      document.removeEventListener('visibilitychange', onVisible)
      es?.close()
    }
  }, [])

  useEffect(() => {
    const bridge = vscodeBridge
    if (!bridge) { return }

    // Listen for bridge initialization (event-driven, no polling)
    const unsubInit = bridge.onInit(() => {
      setIsVSCode(true)
      setUseMockData(false)
    })

    // Listen for events — buffer by session, deliver to pending if session matches.
    // selectedSessionIdRef is updated synchronously (not via React state) so it's
    // always current even before React re-renders.
    const unsubEvent = bridge.onEvent((event: AgentEvent) => {
      // Drop replays/duplicates (EventSource reconnects, overlapping batches).
      // Events without a seq (VS Code webview path) always pass.
      if (!seqTrackerRef.current.accept(event.sessionId, event.seq)) return
      const simEvent: SimulationEvent = {
        time: event.time,
        type: event.type as SimulationEvent['type'],
        payload: event.payload,
        sessionId: event.sessionId,
      }

      // Always buffer by session (for replay on session switch).
      // Capped the same way the simulation's own eventLog is capped (MAX_EVENT_LOG)
      // so a long-running/high-volume session doesn't grow this forever.
      if (event.sessionId) {
        let buf = sessionEventsRef.current.get(event.sessionId)
        if (!buf) {
          buf = new SessionEventBuffer<SimulationEvent>(MAX_SESSION_EVENT_BUFFER)
          sessionEventsRef.current.set(event.sessionId, buf)
        }
        buf.push(simEvent)
        // Keep lastActivityTime roughly current (throttled: one state update per 5s per session)
        // Gated by a ref so setSessions isn't even called (no React render
        // scheduled) for the vast majority of events.
        const now = Date.now()
        const lastTouched = lastActivityTouchRef.current.get(event.sessionId) ?? 0
        if (now - lastTouched >= 5000) {
          lastActivityTouchRef.current.set(event.sessionId, now)
          applySessions(prev => {
            const s = prev.find(x => x.id === event.sessionId)
            if (!s) {
              // Session not listed yet: don't suppress the next update
              lastActivityTouchRef.current.delete(event.sessionId!)
              return prev
            }
            if (now - s.lastActivityTime < 5000) return prev
            return prev.map(x => x.id === event.sessionId ? { ...x, lastActivityTime: now } : x)
          })
        }
      }

      // Deliver to pending if session matches (ref is always current).
      // Skip if a session switch is pending — useLayoutEffect will flush
      // from the session buffer once the simulation state is swapped.
      // Note: no render-trigger state update here — pendingEventsRef is a
      // stable array mutated in place, and the simulation's animation loop
      // (use-agent-simulation.ts) free-polls it every frame via closure and
      // throttles its own UI-facing setState to ~4/sec. Triggering a React
      // render on every single event here would re-render the whole tree at
      // event-arrival rate instead, defeating that throttle.
      const selected = selectedSessionIdRef.current
      if (selected === ALL_SESSIONS_ID) {
        // All view: every session's events feed the one simulation (namespaced, common clock).
        // No "background activity" marks: nothing is in the background.
        if (!sessionSwitchPendingRef.current && event.sessionId) {
          pendingEventsRef.current.push(toAllEvent(simEvent))
          wakeFrames()
        }
      } else if (selected && event.sessionId === selected && !sessionSwitchPendingRef.current) {
        pendingEventsRef.current.push(simEvent)
        // The simulation drains pending from the shared frame loop, which stops
        // when everything is idle: new data must restart it.
        wakeFrames()
      } else if (event.sessionId && event.sessionId !== selected) {
        // Track background activity for unselected sessions
        setSessionsWithActivity(prev => {
          if (prev.has(event.sessionId!)) return prev
          const next = new Set(prev)
          next.add(event.sessionId!)
          return next
        })
      }

      // Re-add dismissed sessions when new events arrive
      if (event.sessionId && dismissedSessionsRef.current.has(event.sessionId)) {
        const saved = dismissedSessionsRef.current.get(event.sessionId)
        dismissedSessionsRef.current.delete(event.sessionId)
        if (saved) {
          applySessions(prev => {
            if (prev.find(s => s.id === saved.id)) return prev
            return [...prev, { ...saved, status: 'active' as const, lastActivityTime: Date.now() }]
          })
        }
      }
    })

    const unsubStatus = bridge.onStatus((status) => {
      setConnectionStatus(status)
    })

    const unsubConfig = bridge.onConfig((config) => {
      if (config.showMockData !== undefined) { setUseMockData(config.showMockData) }
      if (config.disable1MContext !== undefined) { setDisable1MContext(config.disable1MContext) }
    })

    // Session lifecycle tracking
    // Note: these handlers only update session list + selection state.
    // Event flushing is handled by the consumer (index.tsx effect) to avoid
    // races between auto-flush here and save/restore logic there.
    const unsubSession = bridge.onSession((type, data) => {
      if (type === 'reset') {
        // Panel was reopened — clear all stale state
        applySessions(() => [])
        setSelectedSessionId(null)
        selectedSessionIdRef.current = null
        pendingEventsRef.current.length = 0
        switchCursorRef.current = null
        knownSessionIdsRef.current.clear()
        sessionEventsRef.current.clear()
        seqTrackerRef.current.clear()
        setSessionsWithActivity(new Set())
        dismissedSessionsRef.current.clear()
        return
      }
      if (type === 'list') {
        const sessionList = data as SessionInfo[]
        for (const s of sessionList) knownSessionIdsRef.current.add(s.id)
        applySessions(() => sessionList)
        // Evict replay buffers (and cursors) of sessions the relay no longer lists
        const listed = new Set(sessionList.map(s => s.id))
        for (const id of [...sessionEventsRef.current.keys()]) {
          if (!listed.has(id) && id !== selectedSessionIdRef.current) {
            sessionEventsRef.current.delete(id)
            seqTrackerRef.current.forget(id)
          }
        }
        // Auto-select: prefer active sessions, then most recently active.
        // Only set selection — useLayoutEffect handles flushing events.
        if (!selectedSessionIdRef.current && sessionList.length > 0 && readAllViewPreference()) {
          // All is the default view (a missing preference means All)
          beginSwitch(ALL_SESSIONS_ID)
          setSelectedSessionId(ALL_SESSIONS_ID)
        } else if (!selectedSessionIdRef.current && sessionList.length > 0) {
          const sorted = [...sessionList].sort((a, b) => {
            const aActive = a.status === 'active' ? 1 : 0
            const bActive = b.status === 'active' ? 1 : 0
            if (aActive !== bActive) return bActive - aActive
            return b.lastActivityTime - a.lastActivityTime
          })
          const autoId = sorted[0].id
          beginSwitch(autoId)
          setSelectedSessionId(autoId)
        }
      } else if (type === 'started') {
        const session = data as SessionInfo
        // Resume after inactivity re-sends 'started' for a session we may already
        // be showing. Re-arming the switch for the same id would set
        // sessionSwitchPendingRef without anything ever clearing it (the layout
        // effect only runs when the selection changes), freezing event delivery.
        const alreadySelected = session.id === selectedSessionIdRef.current
        // The relay re-sends 'started' when an idle session resumes; only a
        // genuinely new session may take over the view, or every background
        // session waking up would yank the user away from the one they watch.
        const isNewSession = !knownSessionIdsRef.current.has(session.id)
        knownSessionIdsRef.current.add(session.id)
        applySessions(prev => {
          const existing = prev.find(s => s.id === session.id)
          if (existing) {
            // Session resumed after inactivity — mark active again
            return prev.map(s => s.id === session.id
              ? { ...s, status: 'active' as const, lastActivityTime: Date.now() }
              : s)
          }
          return [...prev, session]
        })
        // While All is selected a new session just appears as another cluster
        if (selectedSessionIdRef.current === ALL_SESSIONS_ID) return
        if (alreadySelected || (!isNewSession && selectedSessionIdRef.current)) return
        // Auto-select newly started session.
        // Set switch-pending flag to prevent the animation frame from processing
        // events in the wrong simulation state before useLayoutEffect swaps it.
        beginSwitch(session.id)
        setSelectedSessionId(session.id)
      } else if (type === 'updated') {
        const { sessionId, label } = data as { sessionId: string; label: string }
        applySessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, label } : s
        ))
      } else if (type === 'ended') {
        const sessionId = data as string
        applySessions(prev => prev.map(s =>
          s.id === sessionId ? { ...s, status: 'completed' as const } : s
        ))
      }
    })

    return () => {
      unsubInit()
      unsubEvent()
      unsubStatus()
      unsubConfig()
      unsubSession()
    }
  }, [])

  const consumeEvents = useCallback(() => {
    // Clear in-place so stale closures in animation callbacks
    // also see the cleared array (prevents multi-frame reprocessing)
    pendingEventsRef.current.length = 0
  }, [])

  /** Switch session selection. Does NOT flush events — call flushSessionEvents
   *  from useLayoutEffect after the simulation state has been saved/swapped. */
  const selectSession = useCallback((sessionId: string | null) => {
    // Block event delivery to pending until the simulation state is swapped
    beginSwitch(sessionId)
    setSelectedSessionId(sessionId)
    // Explicit user choice: remember All vs a single session across reloads
    if (sessionId) writeAllViewPreference(sessionId === ALL_SESSIONS_ID)
    if (sessionId === ALL_SESSIONS_ID) {
      setSessionsWithActivity(prev => prev.size === 0 ? prev : new Set())
    } else if (sessionId) {
      setSessionsWithActivity(prev => {
        if (!prev.has(sessionId)) return prev
        const next = new Set(prev)
        next.delete(sessionId)
        return next
      })
    }
  }, [])

  /** Flush buffered events for the selected session into pending.
   *  Must be called from useLayoutEffect AFTER simulation state is saved/swapped. */
  const flushSessionEvents = useCallback((sessionId: string, fromIndex = 0) => {
    sessionSwitchPendingRef.current = false
    let buffered: SimulationEvent[]
    if (sessionId === ALL_SESSIONS_ID) {
      // Every session's buffer, transformed and merged by shifted time
      buffered = mergeEventsByTime(
        [...sessionEventsRef.current.values()].map(buf => buf.sliceFrom(0).map(toAllEvent)),
      )
    } else {
      buffered = sessionEventsRef.current.get(sessionId)?.sliceFrom(fromIndex) ?? []
    }
    pendingEventsRef.current.length = 0
    // push in slices: spreading a huge array can exceed the argument limit
    for (let i = 0; i < buffered.length; i += 5000) pendingEventsRef.current.push(...buffered.slice(i, i + 5000))
    if (buffered.length > 0) wakeFrames()
  }, [])

  const getSessionEventCount = useCallback((sessionId: string): number => {
    return sessionEventsRef.current.get(sessionId)?.end ?? 0
  }, [])

  const takeSwitchCursor = useCallback((sessionId: string): number | undefined => {
    const c = switchCursorRef.current
    if (!c || c.sessionId !== sessionId) return undefined
    switchCursorRef.current = null
    return c.end
  }, [])

  const rebuildAll = useCallback(() => {
    if (selectedSessionIdRef.current !== ALL_SESSIONS_ID) return
    sessionSwitchPendingRef.current = true
    pendingEventsRef.current.length = 0
    setAllRebuildToken(n => n + 1)
  }, [])

  const dismissedSessionsRef = useRef<Map<string, SessionInfo>>(new Map())

  const removeSession = useCallback((sessionId: string) => {
    const prevSessions = sessionsRef.current
    const session = prevSessions.find(s => s.id === sessionId)
    if (session) { dismissedSessionsRef.current.set(sessionId, session) }
    sessionsRef.current = prevSessions.filter(s => s.id !== sessionId)
    setSessions(sessionsRef.current)
    setSessionsWithActivity(prev => {
      if (!prev.has(sessionId)) return prev
      const next = new Set(prev)
      next.delete(sessionId)
      return next
    })
    // Drop the closed session's replay buffer — it's not reachable via the UI
    // until new events re-add it (see "Re-add dismissed sessions" above), at
    // which point it starts a fresh buffer. Otherwise a long-lived page with
    // many opened/closed sessions keeps every closed session's full event
    // history in memory forever.
    sessionEventsRef.current.delete(sessionId)
    lastActivityTouchRef.current.delete(sessionId)
    // Forget the seq cursor too, so a reappearing session replays its history
    seqTrackerRef.current.forget(sessionId)
  }, [])

  const bridgeOpenFile = useCallback((filePath: string, line?: number) => {
    vscodeBridge?.openFile(filePath, line)
  }, [])

  return {
    isVSCode,
    connectionStatus,
    pendingEvents: pendingEventsRef.current,
    consumeEvents,
    useMockData,
    disable1MContext,
    bridgeOpenFile,
    sessions,
    selectedSessionId,
    selectedSessionIdRef,
    selectSession,
    flushSessionEvents,
    getSessionEventCount,
    takeSwitchCursor,
    sessionsWithActivity,
    removeSession,
    allRebuildToken,
    rebuildAll,
  }
}
