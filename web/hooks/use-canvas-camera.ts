import { useRef, useEffect, useCallback, type MutableRefObject } from 'react'
import { Agent, ToolCallNode, Discovery, ANIM } from '@/lib/agent-types'
import { getBottomInset, getTopInset, getRightInset, getLeftInset } from '@/lib/layout-insets'
import { CAMERA } from '@/lib/canvas-constants'
import { computeFitTransform as computeFitTransformPure, createFitCache, type Transform } from '@/lib/compute-fit-transform'

export type { Transform }

interface CameraOptions {
  mainCanvasRef: MutableRefObject<HTMLCanvasElement | null>
  drawPropsRef: MutableRefObject<{
    agents: Map<string, Agent>
    toolCalls: Map<string, ToolCallNode>
    discoveries: Discovery[]
    dimensions: { width: number; height: number }
    selectedAgentId: string | null
    pauseAutoFit?: boolean
    isDragging: boolean
  }>
  simTimeRef: MutableRefObject<number>
  dimensions: { width: number; height: number }
  agentCount: number
  zoomToFitTrigger?: number
  selectedAgentId: string | null
}

export function useCanvasCamera({
  mainCanvasRef,
  drawPropsRef,
  simTimeRef,
  dimensions,
  agentCount,
  zoomToFitTrigger,
  selectedAgentId,
}: CameraOptions) {
  const transformRef = useRef<Transform>({ x: 0, y: 0, scale: 1 })
  const userHasNavigatedRef = useRef(false)
  const targetTransformRef = useRef<Transform | null>(null)
  const panVelocityRef = useRef({ vx: 0, vy: 0, active: false })

  // Cache for computeFitTransform — avoids O(n) iteration every frame.
  // Invalidates on collection reference change (React creates new Map/array on state updates)
  // or viewport dimension change (see lib/compute-fit-transform.ts).
  const fitCacheRef = useRef(createFitCache())

  // Initialize transform centered on first agents
  useEffect(() => {
    if (agentCount > 0 && transformRef.current.x === 0 && transformRef.current.y === 0) {
      transformRef.current = { x: dimensions.width / 2, y: dimensions.height / 2, scale: 1 }
    }
  }, [agentCount, dimensions])

  const computeFitTransform = useCallback((): Transform | null => {
    const { agents, toolCalls, discoveries, dimensions, selectedAgentId } = drawPropsRef.current
    return computeFitTransformPure(
      { agents, toolCalls, discoveries, dimensions, selectedAgentId, simTime: simTimeRef.current ?? 0, bottomInset: getBottomInset(), topInset: getTopInset(), rightInset: getRightInset(), leftInset: getLeftInset() },
      fitCacheRef.current,
    )
  }, [drawPropsRef, simTimeRef])

  const doZoomToFit = useCallback(() => {
    userHasNavigatedRef.current = false
    const target = computeFitTransform()
    if (target) targetTransformRef.current = target
  }, [computeFitTransform])

  /** Visible-area centre (between the top chrome and the bottom bar). */
  const viewCentre = useCallback(() => {
    const { dimensions } = drawPropsRef.current
    const top = getTopInset()
    const bottom = getBottomInset()
    return { cx: dimensions.width / 2, cy: top + Math.max(0, dimensions.height - top - bottom) / 2 }
  }, [drawPropsRef])

  /** Single-pointer zoom (buttons): eases toward a scaled transform around the view centre. */
  const zoomBy = useCallback((factor: number) => {
    const prev = targetTransformRef.current ?? transformRef.current
    const scale = Math.max(CAMERA.minZoom, Math.min(CAMERA.maxZoom, prev.scale * factor))
    if (scale === prev.scale) return
    const { cx, cy } = viewCentre()
    const k = scale / prev.scale
    userHasNavigatedRef.current = true
    panVelocityRef.current.active = false
    targetTransformRef.current = { scale, x: cx - (cx - prev.x) * k, y: cy - (cy - prev.y) * k }
  }, [viewCentre])

  /** Pan (and zoom in if far out) so an agent sits at the view centre. */
  const focusAgent = useCallback((agentId: string) => {
    const agent = drawPropsRef.current.agents.get(agentId)
    if (!agent) return
    const { cx, cy } = viewCentre()
    const base = targetTransformRef.current ?? transformRef.current
    const scale = Math.max(base.scale, 0.8)
    userHasNavigatedRef.current = true
    panVelocityRef.current.active = false
    targetTransformRef.current = { scale, x: cx - agent.x * scale, y: cy - agent.y * scale }
  }, [drawPropsRef, viewCentre])

  useEffect(() => {
    if (zoomToFitTrigger && zoomToFitTrigger > 0) doZoomToFit()
  }, [zoomToFitTrigger, doZoomToFit])

  // Re-engage auto-fit when selection changes
  useEffect(() => {
    userHasNavigatedRef.current = false
    targetTransformRef.current = null
  }, [selectedAgentId])

  const screenToCanvas = useCallback((screenX: number, screenY: number) => {
    const canvas = mainCanvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    const t = transformRef.current
    return {
      x: (screenX - rect.left - t.x) / t.scale,
      y: (screenY - rect.top - t.y) / t.scale,
    }
  }, [mainCanvasRef])

  /** Call from draw loop to update inertia and auto-fit lerp */
  const updateCamera = useCallback((isDragging: boolean, pauseAutoFit?: boolean, deltaTime = 1 / 60) => {
    const transform = transformRef.current
    // Inertia and easing constants are tuned per 60fps frame; scale them by the
    // real frame time so 120fps, 60fps and throttled frames feel the same.
    const frames = Math.min(Math.max(deltaTime * 60, 0), 4)

    // Pan inertia
    const inertia = panVelocityRef.current
    if (inertia.active) {
      transformRef.current = { ...transform, x: transform.x + inertia.vx * frames, y: transform.y + inertia.vy * frames }
      const decay = Math.pow(ANIM.inertiaDecay, frames)
      inertia.vx *= decay
      inertia.vy *= decay
      if (Math.abs(inertia.vx) < 0.1 && Math.abs(inertia.vy) < 0.1) {
        inertia.active = false
      }
    }

    // Auto-fit
    if (!userHasNavigatedRef.current && !isDragging && !pauseAutoFit) {
      const fit = computeFitTransform()
      if (fit) targetTransformRef.current = fit
    }

    // Smooth lerp toward target
    const target = targetTransformRef.current
    if (target) {
      const lerpSpeed = 1 - Math.pow(1 - ANIM.autoFitLerp, frames)
      const t = transformRef.current
      const nx = t.x + (target.x - t.x) * lerpSpeed
      const ny = t.y + (target.y - t.y) * lerpSpeed
      const ns = t.scale + (target.scale - t.scale) * lerpSpeed
      if (Math.abs(target.x - nx) < 0.5 && Math.abs(target.y - ny) < 0.5 && Math.abs(target.scale - ns) < 0.001) {
        targetTransformRef.current = null
        transformRef.current = { x: target.x, y: target.y, scale: target.scale }
      } else {
        transformRef.current = { x: nx, y: ny, scale: ns }
      }
    }
  }, [computeFitTransform])

  return {
    transformRef,
    userHasNavigatedRef,
    panVelocityRef,
    screenToCanvas,
    doZoomToFit,
    zoomBy,
    focusAgent,
    updateCamera,
  }
}
