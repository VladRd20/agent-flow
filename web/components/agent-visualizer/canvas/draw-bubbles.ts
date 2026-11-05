import { Agent } from '@/lib/agent-types'
import { COLORS, withAlpha } from '@/lib/colors'
import { FONT } from '@/lib/canvas-constants'
import { snapToDevice } from './draw-misc'
import { getOverlayFrame, type BubblePlan, type BubbleItemPlan, type OverlayFrame } from './overlay-layout'

export { wrapText } from './draw-misc'

const BUBBLE_PAD = 7
const BUBBLE_RADIUS = 6

function roleStyle(role: BubbleItemPlan['role'], agent: Agent) {
  const isThinking = role === 'thinking'
  return {
    isThinking,
    base: isThinking ? COLORS.bubbleThinkingBase : role === 'user' ? COLORS.bubbleUserBase : COLORS.bubbleAssistantBase,
    text: isThinking ? COLORS.roleThinkingText : role === 'user' ? COLORS.roleUserText : COLORS.roleAssistantText,
    label: isThinking ? 'THINKING' : role === 'user' ? 'USER' : agent.runtime === 'codex' ? 'CODEX' : 'CLAUDE',
  }
}

function drawBubbleStack(ctx: CanvasRenderingContext2D, plan: BubblePlan, agent: Agent, frame: OverlayFrame) {
  const dpr = frame.dpr
  const { rect, side } = plan
  const headerH = frame.captionPx + 6
  const lineH = Math.ceil(frame.captionPx * 1.35)
  let first = true

  for (const it of plan.items) {
    const st = roleStyle(it.role, agent)
    const w = Math.round(it.w)
    const h = Math.round(it.h)
    const x = snapToDevice(side === 'left' ? rect.x + rect.w - it.w : rect.x, dpr)
    const y = snapToDevice(rect.y + it.y, dpr)

    ctx.save()
    ctx.globalAlpha = st.isThinking ? it.alpha * 0.92 : it.alpha

    // Pointer toward the node (first bubble of the stack only)
    if (first) {
      ctx.beginPath()
      if (side === 'right') {
        const my = Math.min(Math.max(plan.sy, y + 8), y + h - 8)
        ctx.moveTo(x + 0.5, my - 4); ctx.lineTo(x - 6, my); ctx.lineTo(x + 0.5, my + 4)
      } else if (side === 'left') {
        const my = Math.min(Math.max(plan.sy, y + 8), y + h - 8)
        ctx.moveTo(x + w - 0.5, my - 4); ctx.lineTo(x + w + 6, my); ctx.lineTo(x + w - 0.5, my + 4)
      } else if (side === 'top') {
        const mx = Math.min(Math.max(plan.sx, x + 10), x + w - 10)
        ctx.moveTo(mx - 4, y + h - 0.5); ctx.lineTo(mx, y + h + 6); ctx.lineTo(mx + 4, y + h - 0.5)
      } else {
        const mx = Math.min(Math.max(plan.sx, x + 10), x + w - 10)
        ctx.moveTo(mx - 4, y + 0.5); ctx.lineTo(mx, y - 6); ctx.lineTo(mx + 4, y + 0.5)
      }
      ctx.closePath()
      ctx.fillStyle = COLORS.labelPlate
      ctx.fill()
      first = false
    }

    // Opaque plate with a faint role tint
    ctx.beginPath()
    ctx.roundRect(x, y, w, h, BUBBLE_RADIUS)
    ctx.fillStyle = COLORS.labelPlate
    ctx.fill()
    ctx.fillStyle = withAlpha(st.base, st.isThinking ? 0.12 : 0.16)
    ctx.fill()
    ctx.strokeStyle = withAlpha(st.base, st.isThinking ? 0.45 : 0.6)
    ctx.lineWidth = 1
    ctx.stroke()

    // Header
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.font = FONT.mono(frame.captionPx, 'bold')
    ctx.fillStyle = st.text + 'cc'
    ctx.fillText(st.label, snapToDevice(x + BUBBLE_PAD, dpr), snapToDevice(y + 4, dpr))

    // Body
    ctx.font = FONT.mono(frame.captionPx, 'normal', st.isThinking)
    ctx.fillStyle = st.isThinking ? st.text + 'e0' : st.text
    for (let i = 0; i < it.lines.length; i++) {
      ctx.fillText(it.lines[i], snapToDevice(x + BUBBLE_PAD, dpr), snapToDevice(y + headerH + i * lineH, dpr))
    }
    if (it.truncated) {
      ctx.fillStyle = st.text + 'b0'
      ctx.fillText('…', snapToDevice(x + BUBBLE_PAD, dpr), snapToDevice(y + headerH + it.lines.length * lineH, dpr))
    }
    ctx.restore()
  }
}

/**
 * Message bubbles attached to agents. Geometry (side, flip, collision
 * avoidance, viewport clamping) is decided per frame in overlay-layout.ts; this
 * only paints, in screen space, as opaque cards.
 */
export function drawMessageBubblesWorld(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  _time: number,
) {
  const frame = getOverlayFrame()
  if (!frame || frame.bubbles.size === 0) return
  ctx.save()
  ctx.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0)
  for (const plan of frame.bubbles.values()) {
    const agent = agents.get(plan.agentId)
    if (!agent) continue
    drawBubbleStack(ctx, plan, agent, frame)
  }
  ctx.restore()
}
