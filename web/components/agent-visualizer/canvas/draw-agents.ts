import { Agent, NODE, ANIM } from '@/lib/agent-types'
import { COLORS, getStateColor, getAgentGroupColor, contextSegments } from '@/lib/colors'
import {
  AGENT_DRAW, CONTEXT_BAR, CONTEXT_RING, STATS_OVERLAY, FOCUS_DIM_ALPHA, LABEL_ZOOM_THRESHOLD, LABEL_ZOOM_BAND,
} from '@/lib/canvas-constants'
import { alphaHex, formatTokens } from '@/lib/utils'
import { truncateText, drawHexagon, CLAUDE_SPARK_D, OPENAI_LOGO_D, OPENAI_LOGO_VIEWBOX } from './draw-misc'
import { getAgentGlowSprite } from './render-cache'
import { getNodeSizeMultiplier } from './node-size'
import type { EaseContext } from './eased-value-map'

/** Smoothstep crossfade for the zoom-based label cutoff — continuous in
 *  zoomScale rather than a hard >= threshold cutoff, so labels fade in/out
 *  as the user zooms instead of popping. */
function labelZoomAlpha(zoomScale: number): number {
  const lo = LABEL_ZOOM_THRESHOLD - LABEL_ZOOM_BAND
  const hi = LABEL_ZOOM_THRESHOLD + LABEL_ZOOM_BAND
  if (zoomScale <= lo) return 0
  if (zoomScale >= hi) return 1
  const t = (zoomScale - lo) / (hi - lo)
  return t * t * (3 - 2 * t)
}

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
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
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
  ctx.shadowColor = color
  ctx.shadowBlur = 6 / scale
  ctx.fill(getOpenAILogoPath())
  ctx.restore()
}

/** Pick the brand logo for the agent's runtime. Defaults to Claude. */
export function drawAgentBrand(
  ctx: CanvasRenderingContext2D,
  cx: number, cy: number, r: number, color: string,
  runtime: Agent['runtime'],
) {
  if (runtime === 'codex') drawOpenAILogo(ctx, cx, cy, r, color)
  else drawClaudeSpark(ctx, cx, cy, r, color)
}

export function drawContextComposition(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  radius: number,
) {
  const bd = agent.contextBreakdown
  const total = agent.tokensUsed
  if (total <= 0) return

  const barWidth = Math.max(CONTEXT_BAR.minWidth, radius * CONTEXT_BAR.widthMultiplier)
  const barHeight = CONTEXT_BAR.barHeight
  const barX = agent.x - barWidth / 2
  const barY = agent.y + radius + CONTEXT_BAR.yOffset

  // Background
  ctx.fillStyle = COLORS.cardBgDark
  ctx.beginPath()
  ctx.roundRect(barX - 2, barY - 2, barWidth + 4, barHeight + 14, CONTEXT_BAR.borderRadius)
  ctx.fill()

  // Label
  ctx.fillStyle = COLORS.textMuted
  ctx.font = `${CONTEXT_BAR.fontSize}px monospace`
  ctx.textAlign = 'center'
  ctx.fillText(`${formatTokens(total)} / ${formatTokens(agent.tokensMax)} tokens`, agent.x, barY + barHeight + CONTEXT_BAR.labelPadding)

  // Segments
  const segments = contextSegments(bd)

  let x = barX
  const maxWidth = barWidth * (total / agent.tokensMax)

  for (const seg of segments) {
    if (seg.value <= 0) continue
    const segWidth = (seg.value / total) * maxWidth
    ctx.fillStyle = seg.color
    ctx.fillRect(x, barY, segWidth, barHeight)
    x += segWidth
  }

  // Remaining capacity
  if (x < barX + barWidth) {
    ctx.fillStyle = COLORS.holoBg05
    ctx.fillRect(x, barY, barX + barWidth - x, barHeight)
  }

  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 0.5
  ctx.strokeRect(barX, barY, barWidth, barHeight)
}

export function drawContextRing(
  ctx: CanvasRenderingContext2D,
  agent: Agent,
  radius: number,
  time: number,
) {
  const bd = agent.contextBreakdown
  const total = agent.tokensUsed
  if (total <= 0) return

  const usage = total / agent.tokensMax
  const ringR = radius + CONTEXT_RING.ringOffset
  const ringW = CONTEXT_RING.ringWidth
  const startAngle = -Math.PI / 2

  // Background ring (empty capacity)
  ctx.beginPath()
  ctx.arc(agent.x, agent.y, ringR, 0, Math.PI * 2)
  ctx.strokeStyle = COLORS.holoBorder06
  ctx.lineWidth = ringW
  ctx.stroke()

  // Filled segments
  const segments = contextSegments(bd)

  let currentAngle = startAngle
  for (const seg of segments) {
    if (seg.value <= 0) continue
    const sweep = (seg.value / agent.tokensMax) * Math.PI * 2
    ctx.beginPath()
    ctx.arc(agent.x, agent.y, ringR, currentAngle, currentAngle + sweep)
    ctx.strokeStyle = seg.color
    ctx.lineWidth = ringW
    ctx.stroke()
    currentAngle += sweep
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
    ctx.strokeStyle = warningColor
    ctx.lineWidth = CONTEXT_RING.glowLineWidth
    ctx.globalAlpha = intensity
    ctx.shadowColor = warningColor
    ctx.shadowBlur = CONTEXT_RING.glowBlur
    ctx.stroke()
    ctx.restore()
  }

  // Percentage label when usage is high
  if (usage > CONTEXT_RING.percentLabelThreshold) {
    ctx.font = `${CONTEXT_BAR.fontSize}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'bottom'
    ctx.fillStyle = usage > CONTEXT_RING.criticalThreshold ? COLORS.error : usage > CONTEXT_RING.warningThreshold ? COLORS.tool : COLORS.textDim
    ctx.fillText(`${Math.floor(usage * 100)}%`, agent.x, agent.y - radius - CONTEXT_RING.percentYOffset)
  }
}

function drawDepthShadow(ctx: CanvasRenderingContext2D, agent: Agent, r: number) {
  ctx.save()
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)'
  ctx.shadowBlur = AGENT_DRAW.shadowBlur
  ctx.shadowOffsetX = AGENT_DRAW.shadowOffsetX
  ctx.shadowOffsetY = AGENT_DRAW.shadowOffsetY
  drawHexagon(ctx, agent.x, agent.y, r * 0.9)
  ctx.fillStyle = COLORS.cardBgFaintOverlay
  ctx.fill()
  ctx.restore()
}

function drawAgentGlow(ctx: CanvasRenderingContext2D, agent: Agent, r: number, color: string, isHovered: boolean, isSelected: boolean, isWaiting: boolean) {
  const glowR = r + AGENT_DRAW.glowPadding
  const glowAlpha = isHovered || isSelected ? 0.35 : isWaiting ? 0.3 : agent.state === 'thinking' ? 0.2 : 0.1
  // Pre-rendered glow sprite instead of per-frame gradient creation
  const sprite = getAgentGlowSprite(color, Math.round(r * 0.5), Math.ceil(glowR), alphaHex(glowAlpha))
  ctx.drawImage(sprite, agent.x - Math.ceil(glowR), agent.y - Math.ceil(glowR))

  // Ambient outer hex ring
  drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.outerRingOffset)
  ctx.strokeStyle = color + '25'
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
    ctx.strokeStyle = ringColor + '60'
  } else if (isWaiting) {
    ctx.setLineDash([6, 4])
    ctx.lineDashOffset = -time * AGENT_DRAW.waitingDashSpeed
    ctx.lineWidth = 2.5
  }
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineDashOffset = 0
}

/** Extra pulsing outer ring for error state — layered on top of the normal
 *  (now group-colored) ring so a failing node still reads unmistakably as
 *  "error" at a glance, even though the base ring no longer hard-codes the
 *  state color. */
function drawErrorAlertRing(ctx: CanvasRenderingContext2D, agent: Agent, r: number, time: number) {
  const pulse = 0.5 + Math.sin(time * 6) * 0.3
  ctx.save()
  drawHexagon(ctx, agent.x, agent.y, r + AGENT_DRAW.outerRingOffset + 2)
  ctx.strokeStyle = COLORS.error
  ctx.lineWidth = 2
  ctx.globalAlpha = pulse
  ctx.shadowColor = COLORS.error
  ctx.shadowBlur = 8
  ctx.stroke()
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
    ctx.strokeStyle = stateColor + '90'
    ctx.fillStyle = stateColor + '90'
    ctx.lineWidth = 1.5
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
    drawAgentBrand(ctx, agent.x, agent.y, r, groupColor + '90', agent.runtime)
  } else {
    // Icon shape (gear vs. diamond) already signals tool_calling vs. other
    // states, so the fill can safely be the node's group/category color.
    ctx.fillStyle = groupColor + '90'
    ctx.font = `${r * AGENT_DRAW.subIconScale}px monospace`
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
    const rippleR = r + AGENT_DRAW.rippleInnerOffset + ripplePhase * AGENT_DRAW.rippleMaxExpand
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

function drawAgentLabel(ctx: CanvasRenderingContext2D, agent: Agent, r: number, isHovered: boolean, alpha: number = 1) {
  ctx.save()
  ctx.globalAlpha *= alpha
  ctx.fillStyle = isHovered ? COLORS.textPrimary : COLORS.textDim
  ctx.font = '10px monospace'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'top'
  const maxLabelW = r * AGENT_DRAW.labelWidthMultiplier
  const agentLabel = truncateText(ctx, agent.name, maxLabelW)
  ctx.fillText(agentLabel, agent.x, agent.y + r + AGENT_DRAW.labelYOffset)
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
  ctx.font = `${STATS_OVERLAY.fontSize}px monospace`
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

    if (agent.state === 'thinking') {
      drawOrbitingParticles(ctx, agent, r, stateColor, time)
    }

    if (isWaiting) {
      drawWaitingRipples(ctx, agent, r, stateColor, time)
    }

    // Labels: always show for the orchestrator, a hovered/selected node, or
    // anything in the active focus set; otherwise sub-agent labels crossfade
    // out at low zoom (smoothstep band around LABEL_ZOOM_THRESHOLD) instead
    // of popping at a hard cutoff, to keep dense graphs readable
    // (Obsidian-style density).
    const forcedLabel = agent.isMain || isHovered || isSelected || (focusSet ? isFocused : false)
    const labelAlpha = forcedLabel ? 1 : labelZoomAlpha(zoomScale)
    if (labelAlpha > 0.01) drawAgentLabel(ctx, agent, r, isHovered, labelAlpha)

    // Context composition — ring for main agent, bar for sub-agents
    if (agent.state !== 'complete' || agent.opacity > 0.5) {
      if (agent.isMain) {
        drawContextRing(ctx, agent, r, time)
      }
      drawContextComposition(ctx, agent, r)
    }

    if (showStats && agent.state !== 'complete') {
      drawStatsOverlay(ctx, agent, r)
    }

    ctx.restore()
  }
}
