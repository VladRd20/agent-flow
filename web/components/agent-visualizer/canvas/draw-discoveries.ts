import { Agent, Discovery } from '@/lib/agent-types'
import { COLORS, getDiscoveryTypeColor } from '@/lib/colors'
import { getDiscoveryCardDimensions, FONT } from '@/lib/canvas-constants'
import { glowStroke } from './draw-misc'
import { truncateText } from './draw-misc'

export function drawDiscoveryConnections(ctx: CanvasRenderingContext2D, discoveries: Discovery[], agents: Map<string, Agent>) {
  for (const disc of discoveries) {
    const agent = agents.get(disc.agentId)
    if (!agent || disc.opacity < 0.1) continue

    ctx.save()
    ctx.globalAlpha = disc.opacity * 0.3
    ctx.strokeStyle = COLORS.holoBase + '30'
    ctx.lineWidth = 0.5
    ctx.setLineDash([3, 5])
    ctx.beginPath()
    ctx.moveTo(agent.x, agent.y)
    ctx.lineTo(disc.x, disc.y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }
}

export function drawDiscoveries(ctx: CanvasRenderingContext2D, discoveries: Discovery[], agents: Map<string, Agent>, selectedDiscoveryId?: string | null) {
  for (const disc of discoveries) {
    if (disc.opacity < 0.05) continue

    ctx.save()
    ctx.globalAlpha = disc.opacity

    const lines = disc.content.split('\n')
    const { cardW, cardH } = getDiscoveryCardDimensions(disc.label, lines)
    const cardX = disc.x - cardW / 2
    const cardY = disc.y - cardH / 2

    const isSelected = disc.id === selectedDiscoveryId

    ctx.beginPath()
    ctx.roundRect(cardX, cardY, cardW, cardH, 3)
    ctx.fillStyle = isSelected ? COLORS.cardBgSelected : COLORS.cardBg
    ctx.fill()

    const typeColor = getDiscoveryTypeColor(disc.type)

    // Selection glow
    if (isSelected) {
      glowStroke(ctx, typeColor + 'a0', 1.5, 0.3)
    }

    ctx.fillStyle = typeColor + 'a0'
    ctx.fillRect(cardX, cardY, 2, cardH)

    if (!isSelected) {
      ctx.strokeStyle = typeColor + '30'
      ctx.lineWidth = 0.5
      ctx.stroke()
    }

    ctx.fillStyle = typeColor
    ctx.font = FONT.mono(8, 'bold')
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    ctx.fillText(truncateText(ctx, disc.label, cardW - 10), cardX + 6, cardY + 3)

    ctx.fillStyle = COLORS.textMuted
    ctx.font = FONT.mono(7)
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(truncateText(ctx, lines[i], cardW - 10), cardX + 6, cardY + 14 + i * 11)
    }

    ctx.restore()
  }
}
