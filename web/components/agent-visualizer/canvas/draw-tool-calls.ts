import { ToolCallNode } from '@/lib/agent-types'
import { COLORS, withAlpha } from '@/lib/colors'
import { TOOL_DRAW, FOCUS_DIM_ALPHA } from '@/lib/canvas-constants'
import { truncateText, snapToDevice, glowStroke } from './draw-misc'
import { getOverlayFrame, type ToolPlan, type OverlayFrame } from './overlay-layout'
import type { EaseContext } from './eased-value-map'

/** Closest point on a rect to (px, py). */
function nearestOnRect(r: { x: number; y: number; w: number; h: number }, px: number, py: number) {
  return { x: Math.min(Math.max(px, r.x), r.x + r.w), y: Math.min(Math.max(py, r.y), r.y + r.h) }
}

function drawToolCard(
  ctx: CanvasRenderingContext2D, tool: ToolCallNode, plan: ToolPlan, frame: OverlayFrame,
  time: number, isSelected: boolean,
) {
  const dpr = frame.dpr
  const isRunning = tool.state === 'running'
  const isError = tool.state === 'error'
  const pulse = isRunning ? Math.sin(time * 4) * 0.2 + 0.8 : isError ? Math.sin(time * 6) * 0.15 + 0.85 : 0.6
  const x = snapToDevice(plan.rect.x, dpr)
  const y = snapToDevice(plan.rect.y, dpr)
  const w = Math.round(plan.rect.w)
  const h = Math.round(plan.rect.h)
  const strokeColor = isError ? COLORS.error + 'c0'
    : isSelected ? COLORS.holoBase + 'cc'
    : isRunning ? COLORS.tool + 'a0' : COLORS.return + '70'

  // Leader line back to the true anchor when the card had to move
  if (plan.displaced) {
    const edge = nearestOnRect({ x, y, w, h }, plan.ax, plan.ay)
    ctx.beginPath()
    ctx.moveTo(edge.x, edge.y)
    ctx.lineTo(plan.ax, plan.ay)
    ctx.strokeStyle = strokeColor
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.stroke()
    ctx.setLineDash([])
    ctx.beginPath()
    ctx.arc(plan.ax, plan.ay, 2.5, 0, Math.PI * 2)
    ctx.fillStyle = strokeColor
    ctx.fill()
  }

  // Opaque plate + state tint
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, TOOL_DRAW.borderRadius + 2)
  ctx.fillStyle = COLORS.labelPlate
  ctx.fill()
  ctx.fillStyle = isError
    ? withAlpha(COLORS.toolCardErrorBase, 0.7 * pulse)
    : isSelected ? withAlpha(COLORS.toolCardSelectedBase, 0.2 * pulse) : withAlpha(COLORS.toolCardBase, 0.5 * pulse)
  ctx.fill()
  ctx.lineWidth = isError ? 1.75 : isSelected ? 1.5 : 1
  if (isError) {
    glowStroke(ctx, strokeColor, 1.75, 0.3)
  } else {
    ctx.strokeStyle = strokeColor
    ctx.stroke()
  }

  // Spinning arc while running
  if (isRunning) {
    ctx.beginPath()
    ctx.arc(x + w / 2, y + h / 2, Math.max(w, h) / 2 + TOOL_DRAW.spinRingPadding, time * TOOL_DRAW.spinSpeed, time * TOOL_DRAW.spinSpeed + TOOL_DRAW.spinArc)
    ctx.strokeStyle = COLORS.tool + '60'
    ctx.lineWidth = 1.5
    ctx.stroke()
  }

  // Text
  const cap = frame.captionPx
  const lineH = Math.ceil(cap * 1.2)
  const cx = snapToDevice(x + w / 2, dpr)
  const line1 = y + 5 + Math.ceil(cap * 1.25) / 2
  ctx.font = frame.captionFont
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const maxTextW = w - 12
  if (isRunning) {
    ctx.fillStyle = COLORS.tool
    ctx.fillText(plan.label, cx, snapToDevice(line1, dpr))
  } else if (isError) {
    ctx.fillStyle = COLORS.error
    ctx.fillText(truncateText(ctx, `${tool.toolName}: FAILED`, maxTextW), cx, snapToDevice(line1, dpr))
    ctx.fillStyle = COLORS.error + 'dd'
    ctx.fillText(truncateText(ctx, tool.errorMessage || tool.result || '', maxTextW), cx, snapToDevice(line1 + lineH, dpr))
  } else {
    ctx.fillStyle = COLORS.return
    ctx.fillText(plan.label, cx, snapToDevice(line1, dpr))
    if (tool.tokenCost) {
      ctx.fillStyle = COLORS.tool + 'cc'
      ctx.fillText(`${tool.tokenCost} tok`, cx, snapToDevice(line1 + lineH, dpr))
    }
  }
}

/**
 * Tool-call cards. Placement (viewport clamp, leader line, collision
 * avoidance) is decided per frame in overlay-layout.ts; this paints them in
 * screen space at constant on-screen size.
 */
export function drawToolCalls(
  ctx: CanvasRenderingContext2D,
  toolCalls: Map<string, ToolCallNode>,
  time: number,
  selectedToolCallId?: string | null,
  /** Click-to-focus set (selected agent node + direct neighbors), or a
   *  lighter hover-preview of the same set. Null = no active focus. A tool
   *  call dims unless it's in the focused neighborhood. */
  focusSet: Set<string> | null = null,
  /** Opacity multiplier for tool calls outside the focus set —
   *  FOCUS_DIM_ALPHA for a click-selection, HOVER_DIM_ALPHA for hover. */
  dimAlpha: number = FOCUS_DIM_ALPHA,
  /** Per-id dim-alpha easing (same EasedValueMap instance style used by
   *  drawAgents/drawEdges). Undefined = apply the target instantly. */
  ease?: EaseContext,
) {
  const frame = getOverlayFrame()
  if (!frame) return
  ctx.save()
  ctx.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0)
  for (const [id, tool] of toolCalls) {
    const plan = frame.tools.get(id)
    const targetDimMultiplier = focusSet && !focusSet.has(id) ? dimAlpha : 1
    const dimMultiplier = ease
      ? ease.dimMap.step(`tool:${id}`, targetDimMultiplier, ease.rate, ease.deltaTime, 1)
      : targetDimMultiplier
    if (!plan) continue

    ctx.save()
    ctx.globalAlpha = tool.opacity * dimMultiplier * plan.alpha
    drawToolCard(ctx, tool, plan, frame, time, id === selectedToolCallId)
    ctx.restore()
  }
  ctx.restore()
}
