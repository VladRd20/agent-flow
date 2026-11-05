'use client'

import { useState, useCallback, useRef, useEffect } from 'react'
import {
  Agent,
  ToolCallNode,
  Edge,
  SimulationEvent,
  type TimelineEntry,
} from '@/lib/agent-types'
import { MOCK_SCENARIO } from '@/lib/mock-scenario'
import { TOOL_CARD_W, TOOL_CARD_H, FORCE, TOOL_SLOT, BUBBLE_VISIBLE_S, MODEL_FAMILY_CONTEXT, DEFAULT_CONTEXT_SIZE, FALLBACK_CONTEXT_SIZE, ANIM_SPEED } from '@/lib/canvas-constants'
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceCollide, forceX, forceY, type Simulation } from 'd3-force'

import type { SimulationState, ForceNode, ForceLink, UseAgentSimulationOptions } from './simulation/types'
import { createEmptyState, MAX_EVENT_LOG } from './simulation/types'
import { processEvent, foldEvents, VISUAL_LIFETIME_S, HISTORICAL_BATCH_MIN, type ProcessEventContext } from './simulation/process-event'
import { computeNextFrame } from './simulation/animate'
import { snapVisualState } from './simulation/snap-visual-state'
import { shouldCommitFrame } from './simulation/ui-throttle'
import { buildForceConfig, type ForceConfig } from './simulation/force-config'
import { ALL_SESSIONS_ID } from '@/lib/all-sessions'
import { frameDriver, wakeFrames, PERF_STATS_ENABLED, type FrameMode } from '@/lib/frame-driver'

/** Per-frame time budget for folding a replay backlog, and fold slice size. */
const FOLD_BUDGET_MS = 8
const FOLD_SLICE = 250

export function useAgentSimulation(options: UseAgentSimulationOptions = {}) {
  const { useMockData = true, externalEvents, onExternalEventsConsumed, sessionFilter, sessionFilterRef: externalFilterRef, disable1MContext = false } = options
  const internalFilterRef = useRef(sessionFilter)
  internalFilterRef.current = sessionFilter
  const sessionFilterRef = externalFilterRef ?? internalFilterRef

  // ─── State management ──────────────────────────────────────────────────────
  // frameRef: source of truth, updated every animation frame (no React render).
  // state: React state for UI components, updated only on structural data changes
  //        (new events, play/pause, seek) — NOT on every animation tick.
  // Canvas reads from frameRef directly for 60fps rendering.
  const [state, setState] = useState<SimulationState>(createEmptyState)
  const frameRef = useRef<SimulationState>(createEmptyState())

  /** Update both frameRef and React state (triggers UI re-render) */
  const commitState = useCallback((next: SimulationState) => {
    frameRef.current = next
    setState(next)
  }, [])

  const lastTimeRef = useRef<number>(0)
  const forceSimRef = useRef<Simulation<ForceNode, ForceLink> | null>(null)
  const blockIdCounter = useRef(0)
  const skipForceSyncRef = useRef(false)
  /** Events received but not yet folded into state (processed under a per-frame time budget). */
  const backlogRef = useRef<SimulationEvent[]>([])
  const animateRef = useRef<(timestamp: number, resumed?: boolean) => FrameMode>(() => 'idle')
  /** Tool starts skipped by historical folds, shared across slices so a later tool_end finds its start */
  const skippedToolsRef = useRef(new Map<string, { args: string; inputData?: Record<string, unknown> }>())
  /** Per-node collide radii (world px) from buildForceConfig, read by forceCollide */
  const radiiRef = useRef<{ radii: Map<string, number>; fallback: number }>({ radii: new Map(), fallback: FORCE.collideRadius })
  /** Per-node anchor pull (All view: keeps each session's cluster in its own cell) */
  const targetsRef = useRef<ForceConfig['targets']>(new Map())
  /** Throttle React UI updates to ~4/sec — canvas stays smooth via frameRef */
  const lastUIUpdateRef = useRef(0)
  const lastUITimeRef = useRef(0)

  // ─── d3-force simulation ─────────────────────────────────────────────────
  useEffect(() => {
    const sim = forceSimulation<ForceNode, ForceLink>([])
      .force('charge', forceManyBody().strength(FORCE.chargeStrength))
      .force('center', forceCenter(0, 0).strength(FORCE.centerStrength))
      .force('collide', forceCollide<ForceNode>(n => radiiRef.current.radii.get(n.id) ?? radiiRef.current.fallback))
      .force('anchorX', forceX<ForceNode>(n => targetsRef.current.get(n.id)?.x ?? 0).strength(n => targetsRef.current.get(n.id)?.strength ?? 0))
      .force('anchorY', forceY<ForceNode>(n => targetsRef.current.get(n.id)?.y ?? 0).strength(n => targetsRef.current.get(n.id)?.strength ?? 0))
      .force('link', forceLink<ForceNode, ForceLink>([]).id(d => d.id).distance(FORCE.linkDistance).strength(FORCE.linkStrength))
      .alphaDecay(FORCE.alphaDecay)
      .velocityDecay(FORCE.velocityDecay)
      .on('tick', () => {
        // Force tick only updates positions — write to frameRef, no React render
        const prev = frameRef.current
        let newAgents: Map<string, Agent> | null = null
        for (const node of sim.nodes()) {
          const agent = (newAgents ?? prev.agents).get(node.id)
          if (agent && !agent.pinned && node.x !== undefined && node.y !== undefined) {
            if (Math.abs(agent.x - node.x) > 0.1 || Math.abs(agent.y - node.y) > 0.1) {
              if (!newAgents) newAgents = new Map(prev.agents)
              newAgents.set(node.id, { ...agent, x: node.x, y: node.y })
            }
          }
        }
        if (newAgents) frameRef.current = { ...prev, agents: newAgents }
      })

    sim.stop()
    forceSimRef.current = sim
    return () => { sim.stop(); forceSimRef.current = null }
  }, [])

  // ─── Force simulation sync ───────────────────────────────────────────────
  const syncForceSimulation = useCallback((agents: Map<string, Agent>, edges: Edge[]) => {
    const sim = forceSimRef.current
    if (!sim) return

    const nodes: ForceNode[] = Array.from(agents.values()).map(a => ({
      id: a.id,
      x: a.x, y: a.y,
      vx: a.vx, vy: a.vy,
      fx: a.pinned ? a.x : undefined,
      fy: a.pinned ? a.y : undefined,
    }))

    const links: ForceLink[] = edges
      .filter(e => e.type === 'parent-child')
      .map(e => ({ id: e.id, source: e.from, target: e.to }))

    const cfg = buildForceConfig(agents, edges)
    radiiRef.current = { radii: cfg.radii, fallback: cfg.fallbackRadius }
    targetsRef.current = cfg.targets
    const charge = sim.force('charge') as ReturnType<typeof forceManyBody> | undefined
    if (charge) charge.strength(cfg.chargeStrength)

    sim.nodes(nodes)
    const linkForce = sim.force('link') as ReturnType<typeof forceLink> | undefined
    if (linkForce) { linkForce.links(links); linkForce.distance(cfg.linkDistance) }
    sim.alpha(0.3).restart()
    for (let i = 0; i < 15; i++) sim.tick()
    sim.stop()
    wakeFrames()
  }, [])

  // ─── Tool slot placement ─────────────────────────────────────────────────
  const findToolSlot = useCallback((
    agent: Agent, agents: Map<string, Agent>,
    toolCalls: Map<string, ToolCallNode>, currentTime: number,
  ): { x: number; y: number } => {
    const visibleBubbles = agent.messageBubbles.filter(b => currentTime - b.time <= BUBBLE_VISIBLE_S)
    const bubbleRect = visibleBubbles.length > 0 ? {
      x1: agent.x + 30, y1: agent.y - 30,
      x2: agent.x + 300, y2: agent.y - 20 + visibleBubbles.length * 60 + 20,
    } : null

    const overlaps = (cx: number, cy: number) => {
      if (bubbleRect && cx + TOOL_CARD_W / 2 > bubbleRect.x1 && cx - TOOL_CARD_W / 2 < bubbleRect.x2
        && cy + TOOL_CARD_H / 2 > bubbleRect.y1 && cy - TOOL_CARD_H / 2 < bubbleRect.y2) return true
      for (const tc of toolCalls.values()) {
        if (Math.abs(cx - tc.x) < TOOL_CARD_W && Math.abs(cy - tc.y) < TOOL_CARD_H) return true
      }
      return false
    }

    let outAngle = -Math.PI / 2
    if (agent.parentId) {
      const parent = agents.get(agent.parentId)
      if (parent) {
        outAngle = Math.atan2(agent.y - parent.y, agent.x - parent.x)
      }
    }

    for (let ring = 1; ring <= TOOL_SLOT.maxRings; ring++) {
      const dist = TOOL_SLOT.baseDistance + ring * TOOL_SLOT.ringIncrement
      const steps = TOOL_SLOT.baseSteps + ring * TOOL_SLOT.stepsPerRing
      for (let i = 0; i < steps; i++) {
        const sweep = (i / (steps - 1) - 0.5) * Math.PI
        const angle = outAngle + sweep
        const cx = agent.x + Math.cos(angle) * dist
        const cy = agent.y + Math.sin(angle) * dist
        if (!overlaps(cx, cy)) return { x: cx, y: cy }
      }
    }
    return { x: agent.x + Math.cos(outAngle) * TOOL_SLOT.fallbackDistance, y: agent.y + Math.sin(outAngle) * TOOL_SLOT.fallbackDistance }
  }, [])

  const getContextWindowSize = useCallback((modelId?: string): number => {
    if (!modelId) return disable1MContext ? DEFAULT_CONTEXT_SIZE : FALLBACK_CONTEXT_SIZE
    const id = modelId.toLowerCase()
    for (const { pattern, size } of MODEL_FAMILY_CONTEXT) {
      if (pattern.test(id)) return disable1MContext ? Math.min(size, DEFAULT_CONTEXT_SIZE) : size
    }
    return DEFAULT_CONTEXT_SIZE
  }, [disable1MContext])

  const makeCtx = useCallback((skipForceSync: boolean): ProcessEventContext => ({
    syncForceSimulation,
    findToolSlot,
    getContextWindowSize,
    blockIdCounter,
    skipForceSync,
  }), [syncForceSimulation, findToolSlot, getContextWindowSize])

  const processEventWithContext = useCallback((event: SimulationEvent, prev: SimulationState): SimulationState => {
    return processEvent(event, prev, makeCtx(skipForceSyncRef.current))
  }, [makeCtx])

  // ─── Animation loop ──────────────────────────────────────────────────────
  // Reads/writes frameRef directly. Only calls commitState when new events
  // are processed, so React only re-renders UI on structural data changes.
  // Returns how busy the sim is so the shared frame driver can idle/throttle.
  const animate = useCallback((timestamp: number, resumed = false): FrameMode => {
    // Frame pacing (120fps cap / 30fps ambient / hidden) is owned by the frame driver.
    if (resumed) lastTimeRef.current = 0
    if (!lastTimeRef.current) lastTimeRef.current = timestamp
    const deltaTime = Math.min((timestamp - lastTimeRef.current) / 1000, ANIM_SPEED.maxDeltaTime)
    lastTimeRef.current = timestamp

    // Snapshot and consume external events OUTSIDE the main processing
    // to avoid React strict mode double-invocation clearing them
    let capturedEvents: SimulationEvent[] | null = null
    if (externalEvents && externalEvents.length > 0 && !useMockData) {
      capturedEvents = externalEvents.slice()
      onExternalEventsConsumed?.()
    }

    const prev = frameRef.current
    if (!prev.isPlaying) return 'idle'

    let newTime = prev.currentTime + deltaTime * prev.speed
    let maxT = Math.max(prev.maxTimeReached, newTime)
    let newEventIndex = prev.eventIndex

    // Process events — thread state through each event
    let currentState = prev
    const newEvents: SimulationEvent[] = []

    if (useMockData) {
      while (newEventIndex < MOCK_SCENARIO.length && MOCK_SCENARIO[newEventIndex].time <= newTime) {
        const evt = MOCK_SCENARIO[newEventIndex]
        currentState = processEventWithContext(evt, currentState)
        newEvents.push(evt)
        newEventIndex++
      }
    } else {
      while (newEventIndex < currentState.eventLog.length && currentState.eventLog[newEventIndex].time <= newTime) {
        const evt = currentState.eventLog[newEventIndex]
        currentState = processEventWithContext(evt, currentState)
        newEventIndex++
      }
    }

    // Process captured external events (snapshotted outside the main
    // processing to avoid React strict mode double-invocation issues)
    if (capturedEvents) {
      // Live events are appended at the tail and eventIndex snapped to the end
      // below; if part of the log had not been replayed yet (review playback,
      // restored snapshot) those events would be skipped forever. Apply them first.
      if (!useMockData) {
        while (newEventIndex < currentState.eventLog.length) {
          const evt = currentState.eventLog[newEventIndex]
          currentState = { ...processEventWithContext(evt, { ...currentState, currentTime: evt.time }), currentTime: evt.time }
          newEventIndex++
        }
        newTime = Math.max(newTime, currentState.currentTime)
      }
      const activeFilter = sessionFilterRef.current
      for (const event of capturedEvents) {
        if (activeFilter && activeFilter !== ALL_SESSIONS_ID && event.sessionId && event.sessionId !== activeFilter) continue
        backlogRef.current.push(event)
      }
    }

    // Fold the backlog with one state copy per slice, under a per-frame time
    // budget so a large replay (initial load / session switch) never blocks a
    // frame. Large backlogs are "historical": visuals that would already have
    // faded by the end of the batch are skipped, and the force layout is synced
    // once at the end instead of per spawn.
    const backlog = backlogRef.current
    if (!useMockData && backlog.length > 0) {
      const historical = backlog.length >= HISTORICAL_BATCH_MIN
      let endTime = newTime
      if (historical) for (const e of backlog) if (e.time > endTime) endTime = e.time
      const visualCutoff = historical ? endTime - VISUAL_LIFETIME_S : undefined
      const ctx = makeCtx(historical)
      const frameStart = performance.now()
      let done = 0
      while (done < backlog.length) {
        const slice = backlog.slice(done, done + FOLD_SLICE)
        const folded = foldEvents(slice, currentState, ctx, {
          resolveTime: (e) => Math.max(e.time || newTime, newTime),
          visualCutoff,
          skippedTools: skippedToolsRef.current,
        })
        currentState = folded.state
        for (const e of folded.applied) newEvents.push(e)
        done += slice.length
        if (historical && performance.now() - frameStart > FOLD_BUDGET_MS) break
      }
      backlog.splice(0, done)
      if (backlog.length === 0) skippedToolsRef.current.clear()
      if (historical && backlog.length === 0) {
        const { agents, edges } = currentState
        setTimeout(() => syncForceSimulation(agents, edges), 0)
      }
    }

    if (!useMockData && newEvents.length > 0) {
      // Sync simulation clock to latest event so active state renders correctly
      newTime = Math.max(newTime, currentState.currentTime)
      maxT = Math.max(maxT, newTime)
    }

    // Append new events to log
    if (newEvents.length > 0) {
      // Single copy: keep only the tail that fits instead of concat-then-slice
      const keepOld = Math.max(0, MAX_EVENT_LOG - newEvents.length)
      const newLog = (keepOld >= currentState.eventLog.length ? currentState.eventLog : currentState.eventLog.slice(currentState.eventLog.length - keepOld))
        .concat(newEvents.length > MAX_EVENT_LOG ? newEvents.slice(newEvents.length - MAX_EVENT_LOG) : newEvents)
      // In mock mode, eventIndex tracks position in MOCK_SCENARIO (not the log).
      // In live mode, eventIndex tracks position in the event log.
      if (!useMockData) {
        newEventIndex = newLog.length
      }
      currentState = { ...currentState, eventLog: newLog }
    }

    currentState = { ...currentState, eventIndex: newEventIndex }

    const result = computeNextFrame(prev, deltaTime, newTime, maxT, currentState, {
      useMockData,
      mockScenarioLength: MOCK_SCENARIO.length,
      mockScenarioEndTime: MOCK_SCENARIO.length > 0 ? MOCK_SCENARIO[MOCK_SCENARIO.length - 1].time : 0,
    })

    // Write to frameRef (canvas reads this every frame)
    frameRef.current = result

    // Force tick — updates agent positions in frameRef. Skipped once the
    // layout has cooled; syncForceSimulation/drag re-heat it.
    const fsim = forceSimRef.current
    const simHot = !!fsim && fsim.alpha() >= fsim.alphaMin()
    if (simHot) fsim!.tick()

    // Throttle React re-renders — UI updates at most ~4/sec, canvas stays smooth via frameRef
    if (shouldCommitFrame({
      now: timestamp,
      lastCommitAt: lastUIUpdateRef.current,
      processedEvents: newEvents.length > 0,
      currentTime: result.currentTime,
      lastCommittedTime: lastUITimeRef.current,
    })) {
      setState(frameRef.current)
      lastUIUpdateRef.current = timestamp
      lastUITimeRef.current = result.currentTime
    }

    // ── Idle detection ──
    // 'full': something structurally animated this frame (or work is queued).
    // 'slow': only ambient animation / clock-driven timers pending (30fps).
    if (useMockData || simHot || newEvents.length > 0 || backlogRef.current.length > 0
      || capturedEvents
      || (!useMockData && result.eventIndex < result.eventLog.length)
      || result.agents !== prev.agents || result.toolCalls !== prev.toolCalls
      || result.edges !== prev.edges || result.particles !== prev.particles
      || result.discoveries !== prev.discoveries) return 'full'
    if (result.toolCalls.size > 0 || result.discoveries.length > 0) return 'slow'
    for (const a of result.agents.values()) {
      if (a.state === 'thinking' || a.state === 'tool_calling' || a.state === 'waiting_permission'
        || a.messageBubbles.length > 0) return 'slow'
    }
    // Settling into idle: flush one final UI commit so throttled-away state
    // (last events, final clock value) reaches React before the loop stops.
    setState(frameRef.current)
    lastUIUpdateRef.current = timestamp
    lastUITimeRef.current = result.currentTime
    return 'idle'
  // eslint-disable-next-line react-hooks/exhaustive-deps -- sessionFilter intentionally omitted; we read sessionFilterRef.current
  }, [processEventWithContext, useMockData, externalEvents, onExternalEventsConsumed])

  animateRef.current = animate

  // Register with the shared frame driver while playing. The driver owns rAF,
  // the 120fps cap, hidden-tab timer ticks (runWhenHidden keeps
  // event draining without rAF) and idling when nothing is animating.
  useEffect(() => {
    if (!state.isPlaying) return
    const unregister = frameDriver.register({
      name: 'sim', order: 0, runWhenHidden: true,
      tick: (ts, resumed) => {
        if (!PERF_STATS_ENABLED) return animateRef.current(ts, resumed)
        const t0 = performance.now()
        const m = animateRef.current(ts, resumed)
        frameDriver.recordTaskMs('sim', performance.now() - t0)
        return m
      },
    })
    return unregister
  }, [state.isPlaying])

  // Live wall-clock heartbeat: while the frame driver is fully idle the sim clock
  // would freeze (looks hung over hours). Advance it at 1Hz without waking the
  // canvas (draw only reacts to scene identities, not currentTime).
  useEffect(() => {
    if (!state.isPlaying || useMockData) return
    let last = performance.now()
    const id = setInterval(() => {
      const now = performance.now()
      const dt = Math.min((now - last) / 1000, 60)
      last = now
      if (!frameDriver.isIdle) return
      const cur = frameRef.current
      if (!cur.isPlaying) return
      const t = cur.currentTime + dt * cur.speed
      frameRef.current = { ...cur, currentTime: t, maxTimeReached: Math.max(cur.maxTimeReached, t) }
      setState(frameRef.current)
    }, 1000)
    return () => clearInterval(id)
  }, [state.isPlaying, useMockData])

  // New external events must wake an idle driver.
  useEffect(() => { wakeFrames() }, [externalEvents, state.speed])

  // ─── Playback controls ───────────────────────────────────────────────────
  const play = useCallback(() => {
    const next = { ...frameRef.current, isPlaying: true }
    commitState(next)
  }, [commitState])

  const pause = useCallback(() => {
    const next = { ...frameRef.current, isPlaying: false }
    commitState(next)
  }, [commitState])

  const setSpeed = useCallback((speed: number) => {
    frameRef.current = { ...frameRef.current, speed }
    setState(prev => ({ ...prev, speed }))
  }, [])

  const restart = useCallback((keepActive = false) => {
    blockIdCounter.current = 0
    backlogRef.current.length = 0
    skippedToolsRef.current.clear()
    if (!keepActive) {
      commitState(createEmptyState({ isPlaying: true, speed: frameRef.current.speed }))
      return
    }
    // Keep active agents but clear completed state and visual history
    const prev = frameRef.current
    const agents = new Map<string, Agent>()
    for (const [id, agent] of prev.agents) {
      if (agent.state !== 'complete') {
        agents.set(id, { ...agent, toolCalls: 0, messageBubbles: [], timeAlive: 0 })
      }
    }

    const edges = prev.edges.filter(e =>
      e.type === 'parent-child' && agents.has(e.from) && agents.has(e.to)
    )

    const timelineEntries = new Map<string, TimelineEntry>()
    for (const [id, entry] of prev.timelineEntries) {
      if (agents.has(id)) {
        timelineEntries.set(id, { ...entry, blocks: [] })
      }
    }

    const conversations: SimulationState['conversations'] = new Map()
    for (const id of agents.keys()) conversations.set(id, [])

    const eventLog = prev.eventLog.filter(e =>
      e.type === 'agent_spawn' && agents.has(e.payload?.name as string)
    )

    const next = {
      ...createEmptyState({ isPlaying: true, speed: prev.speed }),
      agents, edges, timelineEntries, conversations,
      eventLog, eventIndex: eventLog.length,
    }
    commitState(next)
    setTimeout(() => syncForceSimulation(next.agents, next.edges), 0)
  }, [syncForceSimulation, commitState])

  const updateAgentPosition = useCallback((agentId: string, x: number, y: number) => {
    // Drag updates — write to frameRef only (canvas reads it, no React render)
    const prev = frameRef.current
    const newAgents = new Map(prev.agents)
    const agent = newAgents.get(agentId)
    if (!agent) return // e.g. a dimmed finished node: not part of the simulation
    newAgents.set(agentId, { ...agent, x, y, pinned: true })
    frameRef.current = { ...prev, agents: newAgents }

    if (forceSimRef.current) {
      const node = forceSimRef.current.nodes().find(n => n.id === agentId)
      if (node) { node.fx = x; node.fy = y }
      // Gently re-heat so neighbours react to the drag, then cool down again
      if (forceSimRef.current.alpha() < 0.05) forceSimRef.current.alpha(0.05)
    }
    wakeFrames()
  }, [])

  /** Seek to a specific time — replays events from scratch up to targetTime */
  const seekToTime = useCallback((targetTime: number) => {
    const prev = frameRef.current
    const events = useMockData ? MOCK_SCENARIO : prev.eventLog

    let replayState = createEmptyState({
      speed: prev.speed,
      eventLog: prev.eventLog,
      maxTimeReached: prev.maxTimeReached,
    })

    skipForceSyncRef.current = true
    blockIdCounter.current = 0
    let newEventIndex = 0
    for (const event of events) {
      if (event.time > targetTime) break
      replayState.currentTime = event.time
      replayState = { ...processEventWithContext(event, replayState), currentTime: event.time }
      newEventIndex++
    }
    skipForceSyncRef.current = false

    replayState = snapVisualState(replayState, targetTime)
    replayState.currentTime = targetTime
    replayState.eventIndex = newEventIndex

    commitState(replayState)
    setTimeout(() => syncForceSimulation(replayState.agents, replayState.edges), 0)
  }, [processEventWithContext, useMockData, syncForceSimulation, commitState])

  /** All view: make each session's main node (and timeline row) show its current tab label. */
  const relabelMains = useCallback((labels: ReadonlyMap<string, string>) => {
    const prev = frameRef.current
    let agents: Map<string, Agent> | null = null
    let entries: SimulationState['timelineEntries'] | null = null
    const relabel = (map: Map<string, Agent>, hidden = false) => {
      for (const [id, a] of map) {
        const label = a.isMain && a.sessionId ? labels.get(a.sessionId) : undefined
        if (!label || a.name === label || hidden) continue
        if (!agents) agents = new Map(prev.agents)
        agents.set(id, { ...a, name: label })
        const entry = prev.timelineEntries.get(id)
        if (entry && entry.agentName !== label) {
          if (!entries) entries = new Map(prev.timelineEntries)
          entries.set(id, { ...entry, agentName: label })
        }
      }
    }
    relabel(prev.agents)
    if (!agents) return
    commitState({ ...prev, agents, ...(entries ? { timelineEntries: entries } : {}) })
  }, [commitState])

  // ─── Session state save/restore ──────────────────────────────────────────
  /** `pending` = events received but not yet folded into simState (must be re-delivered on restore). */
  const saveSnapshot = useCallback((): { simState: SimulationState; blockId: number; pending: number } => ({
    simState: frameRef.current,
    blockId: blockIdCounter.current,
    pending: backlogRef.current.length,
  }), [])

  const restoreSnapshot = useCallback((snapshot: { simState: SimulationState; blockId: number; pending?: number }) => {
    blockIdCounter.current = snapshot.blockId
    backlogRef.current.length = 0
    skippedToolsRef.current.clear()
    let st = snapshot.simState
    // A snapshot taken while paused/scrubbed still has un-replayed log entries.
    // Restoring it with isPlaying=true would play them back at 1x under a LIVE
    // badge; fast-forward to the end of the log so the tab comes back live.
    if (!useMockData && st.eventIndex < st.eventLog.length) {
      skipForceSyncRef.current = true
      for (const evt of st.eventLog.slice(st.eventIndex)) {
        st = { ...processEventWithContext(evt, { ...st, currentTime: evt.time }), currentTime: evt.time }
      }
      skipForceSyncRef.current = false
      const t = Math.max(st.currentTime, st.maxTimeReached)
      st = { ...snapVisualState(st, t), currentTime: t, eventIndex: st.eventLog.length }
    }
    commitState({ ...st, isPlaying: true })
    setTimeout(() => syncForceSimulation(st.agents, st.edges), 0)
  }, [syncForceSimulation, commitState, useMockData, processEventWithContext])

  return {
    // Canvas reads frameRef directly for 60fps rendering
    frameRef,
    // UI components use React state (updated only on events/user actions)
    agents: state.agents, hiddenAgents: state.hiddenAgents, toolCalls: state.toolCalls,
    particles: state.particles, edges: state.edges,
    discoveries: state.discoveries,
    fileAttention: state.fileAttention,
    timelineEntries: state.timelineEntries,
    currentTime: state.currentTime, isPlaying: state.isPlaying, speed: state.speed,
    maxTimeReached: state.maxTimeReached,
    conversations: state.conversations,
    play, pause, restart, setSpeed, seekToTime,
    updateAgentPosition,
    saveSnapshot, restoreSnapshot, relabelMains,
  }
}
