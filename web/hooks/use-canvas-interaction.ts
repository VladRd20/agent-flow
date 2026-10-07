import { useState, useCallback, useRef, useEffect, type MutableRefObject } from 'react'
import { Agent, ToolCallNode, Discovery, ANIM } from '@/lib/agent-types'
import { CAMERA } from '@/lib/canvas-constants'
import {
  findAgentAt as findAgentAtPure,
  findToolCallAt as findToolCallAtPure,
  findBubbleAgentAt as findBubbleAgentAtPure,
  findDiscoveryAt as findDiscoveryAtPure,
} from '@/components/agent-visualizer/canvas/index'
import type { Transform } from './use-canvas-camera'

interface InteractionCallbacks {
  onAgentClick: (agentId: string | null) => void
  onAgentHover: (agentId: string | null) => void
  onAgentDrag: (agentId: string, x: number, y: number) => void
  onContextMenu: (e: React.MouseEvent, type: 'agent' | 'edge' | 'canvas', id?: string) => void
  onToolCallClick?: (toolCallId: string | null) => void
  onDiscoveryClick?: (discoveryId: string | null) => void
}

interface InteractionOptions {
  drawPropsRef: MutableRefObject<{
    agents: Map<string, Agent>
    toolCalls: Map<string, ToolCallNode>
    discoveries: Discovery[]
  } & InteractionCallbacks>
  transformRef: MutableRefObject<Transform>
  userHasNavigatedRef: MutableRefObject<boolean>
  panVelocityRef: MutableRefObject<{ vx: number; vy: number; active: boolean }>
  simTimeRef: MutableRefObject<number>
  screenToCanvas: (screenX: number, screenY: number) => { x: number; y: number }
  doZoomToFit: () => void
  mainCanvasRef: MutableRefObject<HTMLCanvasElement | null>
}

export function useCanvasInteraction({
  drawPropsRef,
  transformRef,
  userHasNavigatedRef,
  panVelocityRef,
  simTimeRef,
  screenToCanvas,
  doZoomToFit,
  mainCanvasRef,
}: InteractionOptions) {
  const [isDragging, setIsDragging] = useState(false)
  const isDraggingRef = useRef(false)
  const dragTargetRef = useRef<{ type: 'canvas' | 'agent'; id?: string; startX: number; startY: number } | null>(null)
  isDraggingRef.current = isDragging

  // Floaty agent drag
  const dragLerpRef = useRef<{ targetX: number; targetY: number; agentId: string } | null>(null)

  // Pan tracking
  const lastPanPosRef = useRef({ x: 0, y: 0, time: 0 })
  const lastHoveredIdRef = useRef<string | null>(null)

  // ─── Hit detection wrappers ─────────────────────────────────────────────

  const findAgentAt = useCallback((x: number, y: number): string | null => {
    return findAgentAtPure(x, y, drawPropsRef.current.agents)
  }, [drawPropsRef])

  const findToolCallAt = useCallback((x: number, y: number): string | null => {
    return findToolCallAtPure(x, y, drawPropsRef.current.toolCalls)
  }, [drawPropsRef])

  const findBubbleAgentAt = useCallback((x: number, y: number): string | null => {
    return findBubbleAgentAtPure(x, y, drawPropsRef.current.agents, simTimeRef.current)
  }, [drawPropsRef, simTimeRef])

  const findDiscoveryAt = useCallback((x: number, y: number): string | null => {
    return findDiscoveryAtPure(x, y, drawPropsRef.current.discoveries)
  }, [drawPropsRef])

  // ─── Mouse Handlers ─────────────────────────────────────────────────────

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    const pos = screenToCanvas(e.clientX, e.clientY)
    const agentId = findAgentAt(pos.x, pos.y)
    if (e.button === 0) {
      panVelocityRef.current = { vx: 0, vy: 0, active: false }
      setIsDragging(true)
      if (agentId) {
        dragTargetRef.current = { type: 'agent', id: agentId, startX: e.clientX, startY: e.clientY }
      } else {
        dragTargetRef.current = { type: 'canvas', startX: e.clientX, startY: e.clientY }
        lastPanPosRef.current = { x: e.clientX, y: e.clientY, time: performance.now() }
      }
    }
  }, [screenToCanvas, findAgentAt, panVelocityRef])

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const pos = screenToCanvas(e.clientX, e.clientY)
    const hoveredId = findAgentAt(pos.x, pos.y)
    if (hoveredId !== lastHoveredIdRef.current) {
      lastHoveredIdRef.current = hoveredId
      drawPropsRef.current.onAgentHover(hoveredId)
    }
    const dragging = isDraggingRef.current
    const dragTarget = dragTargetRef.current
    if (dragging && dragTarget) {
      if (dragTarget.type === 'canvas') {
        userHasNavigatedRef.current = true
        const dx = e.clientX - dragTarget.startX
        const dy = e.clientY - dragTarget.startY
        const t = transformRef.current
        transformRef.current = { ...t, x: t.x + dx, y: t.y + dy }
        const now = performance.now()
        const elapsed = Math.max(now - lastPanPosRef.current.time, 1) / 1000
        panVelocityRef.current = {
          vx: (e.clientX - lastPanPosRef.current.x) / elapsed * CAMERA.velocityScale,
          vy: (e.clientY - lastPanPosRef.current.y) / elapsed * CAMERA.velocityScale,
          active: false,
        }
        lastPanPosRef.current = { x: e.clientX, y: e.clientY, time: now }
        dragTargetRef.current = { ...dragTarget, startX: e.clientX, startY: e.clientY }
      } else if (dragTarget.type === 'agent' && dragTarget.id) {
        const screenDist = Math.abs(e.clientX - dragTarget.startX) + Math.abs(e.clientY - dragTarget.startY)
        if (screenDist > ANIM.dragThresholdPx) {
          dragLerpRef.current = { targetX: pos.x, targetY: pos.y, agentId: dragTarget.id }
        }
      }
    }
  }, [screenToCanvas, findAgentAt, drawPropsRef, userHasNavigatedRef, transformRef, panVelocityRef])

  const handleMouseUp = useCallback((e: React.MouseEvent) => {
    if (e.button === 2) {
      setIsDragging(false)
      dragTargetRef.current = null
      return
    }
    const dt_ = dragTargetRef.current
    if (dt_?.type === 'canvas') {
      const v = panVelocityRef.current
      if (Math.abs(v.vx) > ANIM.inertiaThreshold || Math.abs(v.vy) > ANIM.inertiaThreshold) {
        panVelocityRef.current.active = true
      }
    }
    const screenDist = dt_
      ? Math.abs(e.clientX - dt_.startX) + Math.abs(e.clientY - dt_.startY)
      : 0
    if (screenDist < ANIM.dragThresholdPx) {
      const pos = screenToCanvas(e.clientX, e.clientY)
      const agentId = findAgentAt(pos.x, pos.y)
      const p = drawPropsRef.current
      if (agentId) {
        p.onAgentClick(agentId)
      } else {
        const bubbleAgentId = findBubbleAgentAt(pos.x, pos.y)
        if (bubbleAgentId) {
          p.onAgentClick(bubbleAgentId)
        } else {
          const toolId = findToolCallAt(pos.x, pos.y)
          if (toolId) {
            p.onToolCallClick?.(toolId)
          } else {
            const discId = findDiscoveryAt(pos.x, pos.y)
            if (discId) {
              p.onDiscoveryClick?.(discId)
            } else {
              p.onAgentClick(null)
              p.onToolCallClick?.(null)
              p.onDiscoveryClick?.(null)
            }
          }
        }
      }
    }
    if (dragLerpRef.current) {
      drawPropsRef.current.onAgentDrag(dragLerpRef.current.agentId, dragLerpRef.current.targetX, dragLerpRef.current.targetY)
      dragLerpRef.current = null
    }
    setIsDragging(false)
    dragTargetRef.current = null
  }, [screenToCanvas, findAgentAt, findBubbleAgentAt, findToolCallAt, findDiscoveryAt, drawPropsRef, panVelocityRef])

  // Wheel handler attached as native event (passive: false) to allow preventDefault
  const handleWheelRef = useRef<(e: WheelEvent) => void>(() => {})
  handleWheelRef.current = (e: WheelEvent) => {
    e.preventDefault()
    userHasNavigatedRef.current = true
    if (e.ctrlKey || e.metaKey) {
      const delta = e.deltaY > 0 ? CAMERA.zoomStepDown : CAMERA.zoomStepUp
      const rect = mainCanvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const mouseX = e.clientX - rect.left
      const mouseY = e.clientY - rect.top
      const prev = transformRef.current
      const newScale = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom, prev.scale * delta))
      transformRef.current = { scale: newScale, x: mouseX - (mouseX - prev.x) * (newScale / prev.scale), y: mouseY - (mouseY - prev.y) * (newScale / prev.scale) }
    } else {
      const prev = transformRef.current
      transformRef.current = { ...prev, x: prev.x - e.deltaX, y: prev.y - e.deltaY }
    }
  }
  useEffect(() => {
    const canvas = mainCanvasRef.current
    if (!canvas) return
    const handler = (e: WheelEvent) => handleWheelRef.current(e)
    canvas.addEventListener('wheel', handler, { passive: false })
    return () => canvas.removeEventListener('wheel', handler)
  }, [mainCanvasRef])

  const handleDoubleClick = useCallback(() => {
    doZoomToFit()
  }, [doZoomToFit])

  // ─── Touch Handlers (mobile) ────────────────────────────────────────────
  // Native listeners (not React synthetic props) attached with passive:false,
  // mirroring the wheel handler above — this is required so preventDefault()
  // actually suppresses the browser's synthesized mouse/click events that
  // would otherwise fire after a touch and double-trigger selection/drag on
  // hybrid touch+mouse devices. Desktop mouse handlers above are untouched.
  const touchStateRef = useRef<{
    mode: 'none' | 'tap-or-pan' | 'agent-drag' | 'pinch'
    startX: number
    startY: number
    lastX: number
    lastY: number
    lastTime: number
    agentId?: string
    pinchStartDist: number
    pinchStartScale: number
    pinchStartTransform: Transform
    pinchMidX: number
    pinchMidY: number
  }>({
    mode: 'none', startX: 0, startY: 0, lastX: 0, lastY: 0, lastTime: 0,
    pinchStartDist: 0, pinchStartScale: 1, pinchStartTransform: { x: 0, y: 0, scale: 1 },
    pinchMidX: 0, pinchMidY: 0,
  })

  const touchDist = (t0: Touch, t1: Touch) => Math.hypot(t1.clientX - t0.clientX, t1.clientY - t0.clientY)
  const touchMid = (t0: Touch, t1: Touch) => ({ x: (t0.clientX + t1.clientX) / 2, y: (t0.clientY + t1.clientY) / 2 })

  const handleTouchStartRef = useRef<(e: TouchEvent) => void>(() => {})
  handleTouchStartRef.current = (e: TouchEvent) => {
    e.preventDefault()
    const s = touchStateRef.current
    if (e.touches.length === 2) {
      const [t0, t1] = [e.touches[0], e.touches[1]]
      s.mode = 'pinch'
      s.pinchStartDist = touchDist(t0, t1)
      s.pinchStartScale = transformRef.current.scale
      s.pinchStartTransform = { ...transformRef.current }
      const mid = touchMid(t0, t1)
      s.pinchMidX = mid.x
      s.pinchMidY = mid.y
      panVelocityRef.current = { vx: 0, vy: 0, active: false }
      setIsDragging(false)
      dragTargetRef.current = null
      // A second finger touching down while an agent-drag was in progress
      // must stop that drag — otherwise updateDragLerp (called unconditionally
      // every draw frame) keeps lerping the dragged agent toward its last
      // target for the rest of the pinch gesture while the user is zooming.
      dragLerpRef.current = null
      return
    }
    const t = e.touches[0]
    if (!t) return
    const pos = screenToCanvas(t.clientX, t.clientY)
    const agentId = findAgentAt(pos.x, pos.y)
    panVelocityRef.current = { vx: 0, vy: 0, active: false }
    s.startX = t.clientX
    s.startY = t.clientY
    s.lastX = t.clientX
    s.lastY = t.clientY
    s.lastTime = performance.now()
    if (agentId) {
      s.mode = 'agent-drag'
      s.agentId = agentId
      setIsDragging(true)
      dragTargetRef.current = { type: 'agent', id: agentId, startX: t.clientX, startY: t.clientY }
    } else {
      s.mode = 'tap-or-pan'
      setIsDragging(true)
      dragTargetRef.current = { type: 'canvas', startX: t.clientX, startY: t.clientY }
      lastPanPosRef.current = { x: t.clientX, y: t.clientY, time: performance.now() }
    }
  }

  const handleTouchMoveRef = useRef<(e: TouchEvent) => void>(() => {})
  handleTouchMoveRef.current = (e: TouchEvent) => {
    e.preventDefault()
    const s = touchStateRef.current
    if (s.mode === 'pinch' && e.touches.length === 2) {
      const [t0, t1] = [e.touches[0], e.touches[1]]
      const dist = touchDist(t0, t1)
      if (s.pinchStartDist > 0) {
        const ratio = dist / s.pinchStartDist
        const newScale = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom, s.pinchStartScale * ratio))
        const canvas = mainCanvasRef.current
        const rect = canvas?.getBoundingClientRect()
        const mid = touchMid(t0, t1)
        const anchorX = rect ? mid.x - rect.left : mid.x
        const anchorY = rect ? mid.y - rect.top : mid.y
        const startRect = { x: s.pinchStartTransform.x, y: s.pinchStartTransform.y, scale: s.pinchStartTransform.scale }
        // Anchor zoom around the pinch midpoint (relative to its position at pinch-start)
        const midRectX = rect ? s.pinchMidX - rect.left : s.pinchMidX
        const midRectY = rect ? s.pinchMidY - rect.top : s.pinchMidY
        transformRef.current = {
          scale: newScale,
          x: anchorX - (midRectX - startRect.x) * (newScale / startRect.scale),
          y: anchorY - (midRectY - startRect.y) * (newScale / startRect.scale),
        }
      }
      userHasNavigatedRef.current = true
      return
    }
    if (s.mode === 'tap-or-pan') {
      const t = e.touches[0]
      if (!t) return
      userHasNavigatedRef.current = true
      const dx = t.clientX - s.lastX
      const dy = t.clientY - s.lastY
      const tr = transformRef.current
      transformRef.current = { ...tr, x: tr.x + dx, y: tr.y + dy }
      const now = performance.now()
      const elapsed = Math.max(now - s.lastTime, 1) / 1000
      panVelocityRef.current = {
        vx: (t.clientX - s.lastX) / elapsed * CAMERA.velocityScale,
        vy: (t.clientY - s.lastY) / elapsed * CAMERA.velocityScale,
        active: false,
      }
      s.lastX = t.clientX
      s.lastY = t.clientY
      s.lastTime = now
    } else if (s.mode === 'agent-drag' && s.agentId) {
      const t = e.touches[0]
      if (!t) return
      const pos = screenToCanvas(t.clientX, t.clientY)
      const screenDist = Math.abs(t.clientX - s.startX) + Math.abs(t.clientY - s.startY)
      if (screenDist > ANIM.dragThresholdPx) {
        dragLerpRef.current = { targetX: pos.x, targetY: pos.y, agentId: s.agentId }
      }
    }
  }

  const handleTouchEndRef = useRef<(e: TouchEvent) => void>(() => {})
  handleTouchEndRef.current = (e: TouchEvent) => {
    e.preventDefault()
    const s = touchStateRef.current
    if (s.mode === 'pinch') {
      // Pinch ended — if one finger remains, resume it as a pan from here
      if (e.touches.length === 1) {
        const t = e.touches[0]
        s.mode = 'tap-or-pan'
        s.startX = t.clientX
        s.startY = t.clientY
        s.lastX = t.clientX
        s.lastY = t.clientY
        s.lastTime = performance.now()
        dragTargetRef.current = { type: 'canvas', startX: t.clientX, startY: t.clientY }
        setIsDragging(true)
        return
      }
      s.mode = 'none'
      setIsDragging(false)
      dragTargetRef.current = null
      return
    }

    if (s.mode === 'tap-or-pan') {
      const v = panVelocityRef.current
      if (Math.abs(v.vx) > ANIM.inertiaThreshold || Math.abs(v.vy) > ANIM.inertiaThreshold) {
        panVelocityRef.current.active = true
      }
      const screenDist = Math.abs(s.lastX - s.startX) + Math.abs(s.lastY - s.startY)
      if (screenDist < ANIM.dragThresholdPx) {
        // Tap — select whatever's under it
        const pos = screenToCanvas(s.lastX, s.lastY)
        const agentId = findAgentAt(pos.x, pos.y)
        const p = drawPropsRef.current
        if (agentId) {
          p.onAgentClick(agentId)
        } else {
          const bubbleAgentId = findBubbleAgentAt(pos.x, pos.y)
          if (bubbleAgentId) {
            p.onAgentClick(bubbleAgentId)
          } else {
            const toolId = findToolCallAt(pos.x, pos.y)
            if (toolId) {
              p.onToolCallClick?.(toolId)
            } else {
              const discId = findDiscoveryAt(pos.x, pos.y)
              if (discId) {
                p.onDiscoveryClick?.(discId)
              } else {
                p.onAgentClick(null)
                p.onToolCallClick?.(null)
                p.onDiscoveryClick?.(null)
              }
            }
          }
        }
      }
    } else if (s.mode === 'agent-drag' && dragLerpRef.current) {
      drawPropsRef.current.onAgentDrag(dragLerpRef.current.agentId, dragLerpRef.current.targetX, dragLerpRef.current.targetY)
      dragLerpRef.current = null
    }

    s.mode = 'none'
    setIsDragging(false)
    dragTargetRef.current = null
  }

  useEffect(() => {
    const canvas = mainCanvasRef.current
    if (!canvas) return
    const onStart = (e: TouchEvent) => handleTouchStartRef.current(e)
    const onMove = (e: TouchEvent) => handleTouchMoveRef.current(e)
    const onEnd = (e: TouchEvent) => handleTouchEndRef.current(e)
    canvas.addEventListener('touchstart', onStart, { passive: false })
    canvas.addEventListener('touchmove', onMove, { passive: false })
    canvas.addEventListener('touchend', onEnd, { passive: false })
    canvas.addEventListener('touchcancel', onEnd, { passive: false })
    return () => {
      canvas.removeEventListener('touchstart', onStart)
      canvas.removeEventListener('touchmove', onMove)
      canvas.removeEventListener('touchend', onEnd)
      canvas.removeEventListener('touchcancel', onEnd)
    }
  }, [mainCanvasRef])

  const handleContextMenuEvent = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const pos = screenToCanvas(e.clientX, e.clientY)
    const agentId = findAgentAt(pos.x, pos.y)
    drawPropsRef.current.onContextMenu(e, agentId ? 'agent' : 'canvas', agentId ?? undefined)
  }, [screenToCanvas, findAgentAt, drawPropsRef])

  const handleMouseLeave = useCallback(() => {
    setIsDragging(false)
    dragTargetRef.current = null
    dragLerpRef.current = null
    if (lastHoveredIdRef.current !== null) {
      lastHoveredIdRef.current = null
      drawPropsRef.current.onAgentHover(null)
    }
  }, [drawPropsRef])

  /** Call from draw loop to update floaty drag lerp */
  const updateDragLerp = useCallback((agents: Map<string, Agent>, onAgentDrag: (id: string, x: number, y: number) => void) => {
    const lerp = dragLerpRef.current
    if (lerp) {
      const agent = agents.get(lerp.agentId)
      if (agent) {
        const lerpFactor = ANIM.dragLerp
        const nx = agent.x + (lerp.targetX - agent.x) * lerpFactor
        const ny = agent.y + (lerp.targetY - agent.y) * lerpFactor
        onAgentDrag(lerp.agentId, nx, ny)
      }
    }
  }, [])

  return {
    isDragging,
    dragLerpRef,
    handlers: {
      onMouseDown: handleMouseDown,
      onMouseMove: handleMouseMove,
      onMouseUp: handleMouseUp,
      onDoubleClick: handleDoubleClick,
      onContextMenu: handleContextMenuEvent,
      onMouseLeave: handleMouseLeave,
    },
    updateDragLerp,
  }
}
