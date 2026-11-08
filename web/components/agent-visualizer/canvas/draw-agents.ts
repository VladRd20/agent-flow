import { Agent, NODE, ANIM } from '@/lib/agent-types'
import { COLORS, getStateColor, getAgentGroupColor, contextSegments } from '@/lib/colors'
import {
  AGENT_DRAW, CONTEXT_RING, STATS_OVERLAY, FOCUS_DIM_ALPHA, LABEL_STACK, FONT,
} from '@/lib/canvas-constants'
import { alphaHex } from '@/lib/utils'
import { drawHexagon, glowStroke, snapToDevice, CLAUDE_SPARK_D, OPENAI_LOGO_D, OPENAI_LOGO_VIEWBOX } from './draw-misc'
import { getAgentGlowSprite, getGlowSprite } from './render-cache'
import { getNodeSizeMultiplier } from './node-size'
import { layoutContextRing } from './context-meter'
import { getOverlayFrame, MODEL_LINE_GAP, type LabelPlan, type OverlayFrame } from './overlay-layout'
import type { EaseContext } from './eased-value-map'

let _claudeSparkPath: Path2D | null = null
export function getClaudeSparkPath() {
  if (!_claudeSparkPath) _claudeSparkPath = new Path2D(CLAUDE_SPARK_D)
  return _claudeSparkPath
}

let _openaiLogoPath: Path2D | null = null
function getOpenAILogoPath() {
  if (!_openaiLogoPath) _openaiLogoPath = new Path2D(OPENAI_LOGO_D)
  return _openaiLogoPath
}

export function drawClaudeSpark(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  const scale = (r * AGENT_DRAW.sparkScale) / AGENT_DRAW.sparkViewBox
  ctx.scale(scale, scale)
  ctx.translate(-AGENT_DRAW.sparkViewBox, -AGENT_DRAW.sparkViewBox + 1)
  ctx.fillStyle = color
  ctx.fill(getClaudeSparkPath())
  ctx.restore()
}

export function drawOpenAILogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number, color: string) {
  ctx.save()
  ctx.translate(cx, cy)
  // Target diameter matches the Claude spark: (r * sparkScale) total.
  const scale = (r * AGENT_DRAW.sparkScale) / OPENAI_LOGO_VIEWBOX
  ctx.scale(scale, scale)
  ctx.translate(-OPENAI_LOGO_VIEWBOX / 2, -OPENAI_LOGO_VIEWBOX / 2)
  ctx.fillStyle = color
  ctx.fill(getOpenAILogoPath())
  ctx.restore()
}

/** Pick the brand logo for the agent's runtime. Defaults to Claude. */
export function drawAgentBrand(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, color: string,
  runtime: Agent['runtime'],
) {
  // Soft halo behind the logo (pre-rendered sprite instead of per-frame shadowBlur)
  const haloR = Math.max(4, Math.ceil(r * 0.5 / 2) * 2)
  ctx.drawImage(getGlowSprite(color.slice(0, 7), haloR, '38', '00'), cx - haloR, cy - haloR)
  if (runtime === 'codex') drawOpenAILogo(ctx, cx, cy, r, color)
  else drawClaudeSpark(ctx, cx, cy, r, color)
}

export function drawContextRing(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  radius: number,
  time: number,
) {
  const total = agent.tokensUsed
  if (total <= 0) return

  const usage = agent.tokensMax > 0 ? total / agent.tokensMax : 1
  const over = usage > 1
  const ringR = radius + CONTEXT_RING.ringOffset
  const ringW = CONTEXT_RING.ringWidth

  // Background ring (empty capacity)
  ctx.beginPath()
  ctx.arc(agent.x, agent.y, ringR, 0, Math.PI * 2)
  ctx.strokeStyle = COLORS.holoBorder12
  ctx.lineWidth = ringW
  ctx.stroke()

  // Filled segments: cumulative sweep is clamped to one full turn, so an
  // over-capacity ring reads as a solid loop instead of wrapping over itself.
  for (const arc of layoutContextRing(contextSegments(agent.contextBreakdown), total, agent.tokensMax)) {
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR, arc.start, arc.end)
    ctx.strokeStyle = arc.color
    ctx.lineWidth = ringW
    ctx.stroke()
  }

  // Over capacity: distinct dashed outer ring in the error color
  if (over) {
    ctx.save()
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR + ringW / 2 + 2.5, 0, Math.PI * 2)
    ctx.setLineDash([5, 3])
    ctx.lineDashOffset = -time * 8
    ctx.strokeStyle = COLORS.error
    ctx.lineWidth = 1.5
    ctx.stroke()
    ctx.restore()
  }

  // Warning glow at high usage
  if (usage > CONTEXT_RING.warningThreshold) {
    const warningColor = usage > CONTEXT_RING.criticalThreshold ? COLORS.error : COLORS.tool
    const intensity = usage > CONTEXT_RING.criticalThreshold
      ? 0.35 + Math.sin(time * 6) * 0.2
      : 0.15 + Math.sin(time * 3) * 0.1

    ctx.save()
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR + CONTEXT_RING.glowPadding, 0, Math.PI * 2)
    ctx.globalAlpha *= intensity
    glowStroke(ctx, warningColor, CONTEXT_RING.glowLineWidth, 0.5)
    ctx.restore()
  }
}

function drawDepthShadow(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  // Soft drop shadow as a pre-rendered sprite (no per-frame shadowBlur)
  const R = Math.max(8, Math.ceil(r * 1.35 / 2) * 2)
  const sprite = getGlowSprite('#000000', R, '6e', '00')
  const d = r * 1.35
  ctx.drawImage(sprite, agent.x + AGENT_DRAW.shadowOffsetX - d, agent.y + AGENT_DRAW.shadowOffsetY - d, d * 2, d * 2)
}

function drawAgentGlow(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isSelected: boolean, isWaiting: boolean) {
  const glowR = r + AGENT_DRAW.glowPadding
  const glowAlpha = isHovered || isSelected ? 0.35 : isWaiting ? 0.3 : agent.state === 'thinking' ? 0.2 : 0.1
  // Pre-rendered glow sprite instead of per-frame gradient creation
  const sprite = getAgentGlowSprite(color, Math.round(r * 0.5), Math.ceil(glowR), alphaHex(glowAlpha))
  ctx.drawImage(sprite, agent.x - Math.ceil(glowR), agent.y - Math.ceil(glowR))

  // Ambient outer hex ring
  drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.outerRingOffset)
  ctx.strokeStyle = color + '45'
  ctx.lineWidth = 1
  ctx.stroke()

  // Inner hex fill
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.fillStyle = COLORS.nodeInterior
  ctx.fill()
}

function drawScanline(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isWaiting: boolean, time: number) {
  const scanSpeed = agent.state === 'thinking' || isHovered || isWaiting ? ANIM.scanline.thinking : ANIM.scanline.normal
  const scanY = agent.y - r + ((time * scanSpeed) % (r * 2))
  ctx.save()
  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.clip()
  const scanGrad = ctx.createLinearGradient(agent.x, scanY - AGENT_DRAW.scanlineHalfH, agent.x, scanY + AGENT_DRAW.scanlineHalfH)
  const scanAlpha = isHovered ? '35' : '20'
  scanGrad.addColorStop(0, color + '00')
  scanGrad.addColorStop(0.5, color + scanAlpha)
  scanGrad.addColorStop(1, color + '00')
  ctx.fillStyle = scanGrad
  ctx.fillRect(agent.x - r, scanY - AGENT_DRAW.scanlineHalfH, r * 2, AGENT_DRAW.scanlineWidth)
  ctx.restore()
}

function drawStateRing(ctx: CanvasRenderingContext2D, agent: Agent, r: number, groupColor: string, isHovered: boolean, isSelected: boolean, isWaiting: boolean, time: number) {
  // The ring is the node's group/category identity by default, but several
  // states override it outright: error (must read as "wrong" at a glance),
  // and tool_calling/paused/complete — these used to be the node's *only*
  // color signal pre-redesign, and icon shape/dash pattern alone weren't
  // enough to carry that distinction once the ring stopped changing hue
  // (a tool-calling node and an idle one became visually identical when
  // both happened to be the same model family). Idle/thinking/waiting keep
  // the group color since those already have their own secondary signals
  // (breathing animation, lock+ripples) and reverting them would undo the
  // redesign's point of giving a node a stable identity color.
  const ringColor = agent.state === 'error' ? COLORS.error
    : agent.state === 'tool_calling' ? COLORS.tool_calling
    : agent.state === 'paused' ? COLORS.paused
    : agent.state === 'complete' ? COLORS.complete
    : groupColor

  drawHexagon(ctx, agent.x, agent.y, r)
  ctx.strokeStyle = ringColor
  ctx.lineWidth = (isSelected || isHovered) ? 2.5 : 2
  if (agent.state === 'complete') {
    ctx.setLineDash([4, 4])
    ctx.strokeStyle = ringColor + '99'
  } else if (isWaiting) {
    ctx.setLineDash([6, 4])
    ctx.lineDashOffset = -time * AGENT_DRAW.waitingDashSpeed
    ctx.lineWidth = 2.5
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
}

/** Secondary, non-colour "finished" cue: a small check badge on the node's upper-right rim. */
function drawCompleteBadge(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  const br = Math.max(4, r * 0.3)
  const bx = agent.x + r * 0.78
  const by = agent.y - r * 0.78
  ctx.save()
  ctx.fillStyle = COLORS.panelBg
  ctx.strokeStyle = COLORS.complete
  ctx.lineWidth = 1.4
  ctx.beginPath()
  ctx.arc(bx, by, br, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  ctx.beginPath()
  ctx.moveTo(bx - br * 0.45, by)
  ctx.lineTo(bx - br * 0.1, by + br * 0.38)
  ctx.lineTo(bx + br * 0.5, by - br * 0.35)
  ctx.stroke()
  ctx.restore()
}

/** Extra pulsing outer ring for error state — layered on top of the normal
 *  (now group-colored) ring so a failing node still reads unmistakably as
 *  "error" at a glance, even though the base ring no longer hard-codes the
 *  state color. */
function drawErrorAlertRing(ctx: CanvasRenderingContext2D, agent: Agent, r: number, time: number) {
  const pulse = 0.5 + Math.sin(time * 6) * 0.3
  ctx.save()
  drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.outerRingOffset + 2)
  ctx.globalAlpha = pulse
  glowStroke(ctx, COLORS.error, 2, 0.35)
  ctx.restore()
}

function drawCenterIcon(
  ctx: CanvasRenderingContext2D, agent: Agent, r: number,
  groupColor: string, stateColor: string, isWaiting: boolean,
) {
  if (isWaiting) {
    // Geometric lock icon — tinted with the state color (amber) since this
    // is a dedicated state signal, not the node's group/category identity.
    const s = r * 0.3
    ctx.save()
    ctx.strokeStyle = stateColor + 'e6'
    ctx.fillStyle = stateColor + 'e6'
    ctx.lineWidth = 1.75
    // Lock body (rounded rect)
    ctx.beginPath()
    ctx.roundRect(agent.x - s * 0.6, agent.y - s * 0.1, s * 1.2, s * 1.0, 2)
    ctx.fill()
    // Lock shackle (arc)
    ctx.beginPath()
    ctx.arc(agent.x, agent.y - s * 0.15, s * 0.4, Math.PI, 0)
    ctx.stroke()
    ctx.restore()
  } else if (agent.isMain) {
    drawAgentBrand(ctx, agent.x, agent.y, r, groupColor + 'd0', agent.runtime)
  } else {
    // Icon shape (gear vs. diamond) already signals tool_calling vs. other
    // states, so the fill can safely be the node's group/category color.
    ctx.fillStyle = groupColor + 'd0'
    ctx.font = FONT.mono(r * AGENT_DRAW.subIconScale)
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(agent.state === 'tool_calling' ? '\u2699' : '\u25C7', agent.x, agent.y)
  }
}

function drawOrbitingParticles(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number) {
  for (let i = 0; i < 4; i++) {
    const angle = time * ANIM.orbitSpeed + (i / 4) * Math.PI * 2
    ctx.beginPath()
    ctx.fillStyle = color + '80'
    ctx.arc(
      agent.x + Math.cos(angle) * (r + AGENT_DRAW.orbitParticleOffset),
      agent.y + Math.sin(angle) * (r + AGENT_DRAW.orbitParticleOffset),
      AGENT_DRAW.orbitParticleSize, 0, Math.PI * 2,
    )
    ctx.fill()
  }
}

function drawWaitingRipples(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, time: number) {
  // Radar ripples — 2 concentric rings expanding outward, staggered
  for (let i = 0; i < 2; i++) {
    const ripplePhase = ((time * 0.65 + i * 0.5) % 1.0)
    // Expansion scales with the node so the ripples stay inside its own footprint
    const expand = Math.min(AGENT_DRAW.rippleMaxExpand, r * 0.45)
    const rippleR = r + AGENT_DRAW.rippleInnerOffset + ripplePhase * expand
    const rippleAlpha = (1 - ripplePhase) * AGENT_DRAW.rippleMaxAlpha
    ctx.beginPath()
    drawHexagon(ctx, agent.x, agent.y, rippleR)
    ctx.strokeStyle = color + alphaHex(rippleAlpha)
    ctx.lineWidth = 1.5 * (1 - ripplePhase)
    ctx.stroke()
  }

  // Slower orbiting particles in amber
  for (let i = 0; i < 3; i++) {
    const angle = time * AGENT_DRAW.waitingOrbitSpeed + (i / 3) * Math.PI * 2
    ctx.beginPath()
    ctx.fillStyle = color + '70'
    ctx.arc(
      agent.x + Math.cos(angle) * (r + AGENT_DRAW.waitingOrbitOffset),
      agent.y + Math.sin(angle) * (r + AGENT_DRAW.waitingOrbitOffset),
      AGENT_DRAW.waitingOrbitParticleSize, 0, Math.PI * 2,
    )
    ctx.fill()
  }
}

/**
 * Screen-space label stack (name + context bar + token text on one plate).
 * Geometry comes from the declutter pass in overlay-layout.ts; everything is
 * snapped to the device pixel grid and drawn at constant on-screen size.
 */
function drawLabelStack(
  ctx: CanvasRenderingContext2D, plan: LabelPlan, frame: OverlayFrame, agent: Agent,
  emphasized: boolean, alpha: number,
) {
  const { rect, columnW } = plan
  const dpr = frame.dpr
  const x = snapToDevice(rect.x, dpr)
  const y = snapToDevice(rect.y, dpr)
  const w = Math.round(rect.w)
  const h = Math.round(rect.h)

  ctx.save()
  ctx.globalAlpha = alpha * plan.alpha

  // Plate
  ctx.beginPath()
  ctx.roundRect(x, y, w, h, 6)
  ctx.fillStyle = COLORS.labelPlate
  ctx.fill()
  ctx.strokeStyle = plan.over ? COLORS.error + '80' : COLORS.labelPlateBorder
  ctx.lineWidth = 1
  ctx.stroke()

  // Name
  const cx = snapToDevice(x + w / 2, dpr)
  const nameTop = y + LABEL_STACK.padY
  ctx.font = frame.labelFont
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillStyle = emphasized ? COLORS.textPrimary : COLORS.textDim
  ctx.fillText(plan.name, cx, snapToDevice(nameTop, dpr))

  // Model line, tinted with the node's model-family color
  const nameH = Math.ceil(frame.labelPx * 1.25)
  let below = nameTop + nameH
  if (plan.modelText) {
    const modelTop = below + MODEL_LINE_GAP
    ctx.font = frame.captionFont
    ctx.fillStyle = plan.modelColor
    ctx.globalAlpha = alpha * plan.alpha * (emphasized ? 1 : 0.8)
    ctx.fillText(plan.modelText, cx, snapToDevice(modelTop, dpr))
    ctx.globalAlpha = alpha * plan.alpha
    below = modelTop + Math.ceil(frame.captionPx * 1.25)
  }

  if (plan.bar && plan.tokenText) {
    const barX = snapToDevice(x + (w - columnW) / 2, dpr)
    const barY = snapToDevice(below + LABEL_STACK.innerGap, dpr)
    const barH = LABEL_STACK.barHeight
    const bar = plan.bar

    // Track + segments, clipped to the rounded bar so nothing can overflow it
    ctx.save()
    ctx.beginPath()
    ctx.roundRect(barX, barY, columnW, barH, barH / 2)
    ctx.clip()
    ctx.fillStyle = COLORS.holoBg10
    ctx.fillRect(barX, barY, columnW, barH)
    for (const seg of bar.segments) {
      ctx.fillStyle = seg.color
      ctx.fillRect(barX + seg.start * columnW, barY, Math.max(0, (seg.end - seg.start) * columnW), barH)
    }
    if (bar.over) {
      // Over capacity: solid red end cap
      ctx.fillStyle = COLORS.error
      ctx.fillRect(barX + columnW - LABEL_STACK.overCapWidth, barY, LABEL_STACK.overCapWidth, barH)
    }
    ctx.restore()
    ctx.beginPath()
    ctx.roundRect(barX, barY, columnW, barH, barH / 2)
    ctx.strokeStyle = bar.over ? COLORS.error : COLORS.glassBorder
    ctx.lineWidth = 0.75
    ctx.stroke()

    // Token text
    ctx.font = frame.captionFont
    ctx.fillStyle = bar.over ? COLORS.error : COLORS.textMuted
    ctx.fillText(bar.over ? plan.tokenText + ' !' : plan.tokenText, cx, snapToDevice(barY + barH + LABEL_STACK.innerGap, dpr))
  }
  ctx.restore()
}

/** Pass B: all label stacks, drawn in screen space after every node. */
function drawLabelPass(
  ctx: CanvasRenderingContext2D, agents: Map<string, Agent>, frame: OverlayFrame,
  hoveredAgentId: string | null, selectedAgentId: string | null, alphaById: Map<string, number>,
) {
  ctx.save()
  ctx.setTransform(frame.dpr, 0, 0, frame.dpr, 0, 0)
  for (const [id, plan] of frame.labels) {
    const agent = agents.get(id)
    if (!agent) continue
    const alpha = alphaById.get(id) ?? agent.opacity
    if (alpha < 0.02) continue
    drawLabelStack(ctx, plan, frame, agent, agent.isMain || id === hoveredAgentId || id === selectedAgentId, alpha)
  }
  ctx.restore()
}

function drawStatsOverlay(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  const sy = agent.y - r - STATS_OVERLAY.yOffset
  ctx.fillStyle = COLORS.cardBgDark
  ctx.beginPath()
  ctx.roundRect(agent.x - STATS_OVERLAY.boxWidth / 2, sy, STATS_OVERLAY.boxWidth, STATS_OVERLAY.boxHeight, STATS_OVERLAY.borderRadius)
  ctx.fill()
  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 0.5
  ctx.stroke()
  ctx.fillStyle = COLORS.textMuted
  ctx.font = FONT.mono(STATS_OVERLAY.fontSize)
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  ctx.fillText(`${agent.toolCalls} tools \u00B7 ${agent.timeAlive.toFixed(1)}s`, agent.x, sy + STATS_OVERLAY.textPaddingY)
}

export function drawAgents(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  selectedAgentId: string | null,
  hoveredAgentId: string | null,
  showStats: boolean,
  time: number,
  /** Click-to-focus set (selected node + direct neighbors, or a lighter
   *  hover-preview of the same set). Null = no active focus, everything
   *  draws at full opacity. See computeFocusSet(). */
  focusSet: Set<string> | null = null,
  /** Per-agent connected-edge counts (parent-child + tool), used to size
   *  busier nodes larger (Obsidian-style). Null = everyone draws at their
   *  base category radius. See computeDegreeMap() in node-size.ts. */
  degreeMap: Map<string, number> | null = null,
  /** Current camera zoom (transform.scale). Used to hide sub-agent labels
   *  at low zoom so dense graphs stay readable. Defaults to 1 (always
   *  visible) for callers/tests that don't track zoom. */
  zoomScale: number = 1,
  /** Opacity multiplier for agents outside the focus set — FOCUS_DIM_ALPHA
   *  for a click-selection, HOVER_DIM_ALPHA for a lighter hover preview. */
  dimAlpha: number = FOCUS_DIM_ALPHA,
  /** Per-id easing for the dim multiplier and degree-based size multiplier.
   *  Undefined = apply both targets instantly (used by tests/callers that
   *  don't track per-frame state). */
  ease?: EaseContext,
) {
  // Per-node alpha (fade-in/out x focus dim) reused by the label pass
  const alphaById = new Map<string, number>()

  // Pass A: glows, hexagons, rings, icons for every node
  for (const [id, agent] of agents) {
    const radius = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const stateColor = getStateColor(agent.state)
    const groupColor = getAgentGroupColor(agent)
    const isHovered = id === hoveredAgentId
    const isSelected = id === selectedAgentId
    const isFocused = focusSet ? focusSet.has(id) : true

    const isWaiting = agent.state === 'waiting_permission'

    const breathe = isWaiting
      ? Math.sin(time * AGENT_DRAW.waitingBreatheSpeed) * AGENT_DRAW.waitingBreatheAmp + 1
      : agent.state === 'thinking'
      ? Math.sin(time * ANIM.breathe.thinkingSpeed) * ANIM.breathe.thinkingAmp + 1
      : agent.state === 'idle' ? Math.sin(time * ANIM.breathe.idleSpeed) * ANIM.breathe.idleAmp + 1 : 1

    const targetSizeMultiplier = degreeMap ? getNodeSizeMultiplier(id, degreeMap) : 1
    const sizeMultiplier = ease?.sizeMap
      ? ease.sizeMap.step(`agent:${id}`, targetSizeMultiplier, ease.sizeRate ?? ease.rate, ease.deltaTime, 1)
      : targetSizeMultiplier
    const r = radius * breathe * agent.scale * sizeMultiplier

    // Focus dimming is a pure rendering multiplier on top of the agent's own
    // fade-in/out opacity (agent.opacity) — it never touches the animation
    // model's target-opacity state, so it can't regress the session-switch
    // replay fade-in fix in animate.ts. Eased per-id (when `ease` is
    // supplied) so a click/hover change fades the dim in/out instead of
    // snapping — and because it's always read from the current on-screen
    // value, re-focusing mid-transition just retargets, never jumps.
    const targetDimMultiplier = focusSet && !isFocused ? dimAlpha : 1
    const dimMultiplier = ease
      ? ease.dimMap.step(`agent:${id}`, targetDimMultiplier, ease.rate, ease.deltaTime, 1)
      : targetDimMultiplier

    ctx.save()
    ctx.globalAlpha = agent.opacity * dimMultiplier

    drawDepthShadow(ctx, agent, r)
    drawAgentGlow(ctx, agent, r, groupColor, isHovered, isSelected, isWaiting)
    drawScanline(ctx, agent, r, groupColor, isHovered, isWaiting, time)
    drawStateRing(ctx, agent, r, groupColor, isHovered, isSelected, isWaiting, time)
    if (agent.state === 'error') drawErrorAlertRing(ctx, agent, r, time)
    drawCenterIcon(ctx, agent, r, groupColor, stateColor, isWaiting)
    if (agent.state === 'complete') drawCompleteBadge(ctx, agent, r)

    if (agent.state === 'thinking') {
      drawOrbitingParticles(ctx, agent, r, stateColor, time)
    }

    if (isWaiting) {
      drawWaitingRipples(ctx, agent, r, stateColor, time)
    }

    // Context ring (main agent only). Name / bar / token text live in the
    // label pass below so they can be decluttered across all nodes.
    if (agent.isMain && (agent.state !== 'complete' || agent.opacity > 0.5)) {
      drawContextRing(ctx, agent, r, time)
    }
    alphaById.set(id, agent.opacity * dimMultiplier)

    if (showStats && agent.state !== 'complete') {
      drawStatsOverlay(ctx, agent, r)
    }

    ctx.restore()
  }

  // Pass B: label stacks (priority declutter; see overlay-layout.ts)
  const frame = getOverlayFrame()
  if (frame) drawLabelPass(ctx, agents, frame, hoveredAgentId, selectedAgentId, alphaById)
}