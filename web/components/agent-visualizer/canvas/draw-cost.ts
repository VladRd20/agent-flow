import type { UsageLedger } from '@/hooks/simulation/usage-ledger'
import { Agent, ToolCallNode, NODE } from '@/lib/agent-types'
import { COLORS, getAgentGroupColor, getModelFamily } from '@/lib/colors'
import { FONT, COST_RATE, MODEL_FAMILY_COST, COST_DRAW, COST_PANEL, MIN_VISIBLE_OPACITY } from '@/lib/canvas-constants'
import { formatTokens } from '@/lib/utils'
import { truncateText } from './draw-misc'
import { getOverlayFrame } from './overlay-layout'
import { getTopInset, setTopInset, setRightInset } from '@/lib/layout-insets'

/** Blended $/M-token rate for a model ID — first matching family wins,
 *  unknown models fall back to the Sonnet-class rate. */
export function modelCostRate(model?: string): number {
  if (model) {
    const id = model.toLowerCase()
    for (const { pattern, rate } of MODEL_FAMILY_COST) {
      if (pattern.test(id)) return rate
    }
  }
  return COST_RATE
}

export function agentCost(tokensUsed: number, model?: string): number {
  return (tokensUsed / 1_000_000) * modelCostRate(model)
}

/** Tool name -> color for mini cost bar */
export function toolTypeColor(toolName: string): string {
  const n = toolName.toLowerCase()
  if (n.includes('read') || n.includes('glob') || n.includes('grep')) return COLORS.contextUser
  if (n.includes('edit') || n.includes('write')) return COLORS.contextReasoning
  if (n.includes('bash')) return COLORS.tool
  return COLORS.contextSubagent
}

/** Pre-group tool calls by agentId to avoid O(agents * toolCalls) per frame */
function groupToolsByAgent(toolCalls: Map<string, ToolCallNode>): Map<string, ToolCallNode[]> {
  const grouped = new Map<string, ToolCallNode[]>()
  for (const tc of toolCalls.values()) {
    if (!tc.tokenCost) continue
    let list = grouped.get(tc.agentId)
    if (!list) { list = []; grouped.set(tc.agentId, list) }
    list.push(tc)
  }
  return grouped
}

export function drawCostLabels(
  ctx: CanvasRenderingContext2D,
  agents: Map<string, Agent>,
  toolCalls: Map<string, ToolCallNode>,
) {
  const toolsByAgent = groupToolsByAgent(toolCalls)

  for (const [, agent] of agents) {
    if (agent.opacity < MIN_VISIBLE_OPACITY) continue
    const cost = agentCost(agent.tokensUsed, agent.model)
    if (cost < COST_DRAW.minDisplayCost) continue

    const r = agent.isMain ? NODE.radiusMain : NODE.radiusSub
    const pillY = agent.y - r - COST_DRAW.pillYOffset

    // Floating cost pill
    const label = `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(3)}`
    ctx.font = FONT.mono(9, 'bold')
    const labelW = ctx.measureText(label).width
    const pillW = labelW + COST_DRAW.pillPadding
    const pillH = COST_DRAW.pillHeight
    const pillX = agent.x - pillW / 2

    ctx.save()
    ctx.globalAlpha = agent.opacity * 0.9

    // Pill background
    ctx.fillStyle = COLORS.costPillBg
    ctx.strokeStyle = COLORS.costPillStroke
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.roundRect(pillX, pillY, pillW, pillH, COST_DRAW.pillRadius)
    ctx.fill()
    ctx.stroke()

    // Cost text
    ctx.fillStyle = COLORS.costText
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(label, agent.x, pillY + pillH / 2)

    // Mini tool-type cost bar below the pill
    const agentTools = toolsByAgent.get(agent.id)
    if (agentTools && agentTools.length > 0) {
      // Group by tool type
      const byType = new Map<string, number>()
      let totalToolTokens = 0
      for (const tc of agentTools) {
        const tokens = tc.tokenCost || 0
        const key = tc.toolName
        byType.set(key, (byType.get(key) || 0) + tokens)
        totalToolTokens += tokens
      }
      if (totalToolTokens > 0) {
        const barW = Math.min(pillW + COST_DRAW.miniBarMaxExtra, COST_DRAW.miniBarMax)
        const barH = COST_DRAW.miniBarHeight
        const barX = agent.x - barW / 2
        const barY = pillY + pillH + COST_DRAW.miniBarGap

        // Bar background
        ctx.fillStyle = COLORS.holoBorder06
        ctx.beginPath()
        ctx.roundRect(barX, barY, barW, barH, COST_DRAW.miniBarRadius)
        ctx.fill()

        // Segments
        let segX = barX
        for (const [toolName, tokens] of byType) {
          const segW = (tokens / totalToolTokens) * barW
          if (segW < 1) continue
          ctx.fillStyle = toolTypeColor(toolName)
          ctx.globalAlpha = agent.opacity * 0.7
          ctx.beginPath()
          ctx.roundRect(segX, barY, segW, barH, COST_DRAW.miniBarRadius)
          ctx.fill()
          segX += segW
        }
      }
    }

    ctx.restore()
  }
}

const COST_CARD_KEY = 'cost-card'
const COST_CARD_GAP = 16

/** Tell fit-to-view what the card covers: a top band on phones, a right column on wide layouts. */
function publishCostCardInset(narrow: boolean, bottom: number, rightWidth: number): void {
  setTopInset(COST_CARD_KEY, narrow ? bottom + COST_CARD_GAP : 0)
  setRightInset(COST_CARD_KEY, narrow ? 0 : rightWidth + COST_CARD_GAP)
}

/** Withdraw the card's insets (card hidden or nothing to show). */
export function clearCostCardInset(): void {
  setTopInset(COST_CARD_KEY, 0)
  setRightInset(COST_CARD_KEY, 0)
}

export type CostRowStatus = 'running' | 'complete' | 'removed'

export interface CostRow {
  id: string
  name: string
  isMain: boolean
  model?: string
  tokens: number
  cost: number
  status: CostRowStatus
}

/** Reconciling row: everything the visible per-agent rows do not show, so they sum to the total. */
export interface CostRestRow {
  count: number
  tokens: number
  cost: number
  label: string
}

function rowStatus(agent: Agent | undefined): CostRowStatus {
  if (!agent) return 'removed'
  return agent.state === 'complete' || agent.state === 'error' ? 'complete' : 'running'
}

/** Per-agent and per-tool cost rows derived from the cumulative ledger (survives agent/tool removal).
 *  `liveAgents` (the graph's current agents) marks which ledger entries are still on screen; when given,
 *  `rows` lists running agents first, then finished ones, each by cost, capped at `maxRows`, and `rest`
 *  folds every removed agent (plus any overflow) into one reconciling "Finished/removed agents" row. */
export function ledgerBreakdown(
  ledger: UsageLedger,
  liveAgents?: ReadonlyMap<string, Agent>,
  maxRows: number = COST_PANEL.maxRows,
) {
  const all: CostRow[] = Array.from(ledger.agents, ([id, a]) => ({
    id,
    name: a.name,
    isMain: a.isMain,
    model: a.model,
    tokens: a.tokens,
    cost: agentCost(a.tokens, a.model),
    status: liveAgents ? rowStatus(liveAgents.get(id)) : 'running',
  }))
  const totalTokens = all.reduce((s, a) => s + a.tokens, 0)
  const totalCost = all.reduce((s, a) => s + a.cost, 0)

  const statusOrder: Record<CostRowStatus, number> = { running: 0, complete: 1, removed: 2 }
  const agentBreakdown = all.slice().sort((a, b) => b.cost - a.cost)
  const live = all.filter(r => r.status !== 'removed')
    .sort((a, b) => statusOrder[a.status] - statusOrder[b.status] || b.cost - a.cost)
  const rows = liveAgents ? live.slice(0, maxRows) : agentBreakdown.slice(0, maxRows)
  const shown = new Set(rows.map(r => r.id))
  const restList = all.filter(r => !shown.has(r.id))
  const rest: CostRestRow | null = restList.length === 0 ? null : {
    count: restList.length,
    tokens: restList.reduce((s, r) => s + r.tokens, 0),
    cost: restList.reduce((s, r) => s + r.cost, 0),
    label: restList.every(r => r.status === 'removed') ? 'Finished/removed agents' : 'Other + finished agents',
  }

  // Per-tool-type breakdown, costed at the owning agent's model rate
  const toolBreakdown = new Map<string, { tokens: number; cost: number }>()
  for (const t of ledger.tools.values()) {
    const entry = toolBreakdown.get(t.toolName) || { tokens: 0, cost: 0 }
    entry.tokens += t.tokens
    entry.cost += agentCost(t.tokens, ledger.agents.get(t.agentId)?.model)
    toolBreakdown.set(t.toolName, entry)
  }
  const toolList = Array.from(toolBreakdown.entries())
    .map(([name, { tokens, cost }]) => ({ name, tokens, cost }))
    .sort((a, b) => b.cost - a.cost)
  return { agentBreakdown, rows, rest, totalTokens, totalCost, toolList }
}

/** Non-colour status cue for a cost row: pulsing dot (running), check (complete), dash (removed). */
export function drawStatusGlyph(
  ctx: CanvasRenderingContext2D,
  status: CostRowStatus,
  cx: number,
  cy: number,
  size: number,
  now: number = 0,
) {
  ctx.save()
  ctx.lineCap = 'round'
  ctx.lineJoin = 'round'
  if (status === 'running') {
    const pulse = 0.5 + 0.5 * Math.sin(now / 350)
    ctx.fillStyle = COLORS.idle
    ctx.globalAlpha = 0.2 + 0.25 * pulse
    ctx.beginPath()
    ctx.arc(cx, cy, size * (0.8 + 0.2 * pulse), 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
    ctx.beginPath()
    ctx.arc(cx, cy, size * 0.5, 0, Math.PI * 2)
    ctx.fill()
  } else if (status === 'complete') {
    ctx.strokeStyle = COLORS.complete
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(cx - size * 0.6, cy)
    ctx.lineTo(cx - size * 0.15, cy + size * 0.5)
    ctx.lineTo(cx + size * 0.65, cy - size * 0.5)
    ctx.stroke()
  } else {
    ctx.strokeStyle = COLORS.textMuted
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.moveTo(cx - size * 0.5, cy)
    ctx.lineTo(cx + size * 0.5, cy)
    ctx.stroke()
  }
  ctx.restore()
}

/** Short model-family tag for a cost row (opus / sonnet / haiku / gpt ...), or null when unknown. */
export function modelTag(model?: string): string | null {
  return getModelFamily(model)
}

export function drawCostSummaryPanel(
  ctx: CanvasRenderingContext2D,
  ledger: UsageLedger,
  liveAgents?: ReadonlyMap<string, Agent>,
) {
  const { agentBreakdown, rows, rest, totalTokens, totalCost, toolList } = ledgerBreakdown(ledger, liveAgents)
  if (agentBreakdown.length === 0) { clearCostCardInset(); return }

  // Panel dimensions — positioned top-right
  // Viewport width comes from the per-frame overlay layout (explicit dpr-independent CSS px);
  // the canvas-size derivation is only a fallback for callers without a frame.
  const frame = getOverlayFrame()
  const canvasW = frame ? frame.vw : (ctx.canvas.clientWidth || ctx.canvas.width)
  // Phones: full-width card with larger type; it sits below whatever top chrome
  // (tabs, message pill) is showing instead of at a fixed y underneath it.
  const narrow = canvasW < COST_PANEL.width * 2.4
  const margin = narrow ? 12 : COST_PANEL.xMargin
  const panelW = narrow ? canvasW - margin * 2 : COST_PANEL.width
  const panelX = canvasW - panelW - margin
  const panelY = Math.max(COST_PANEL.yStart, getTopInset(COST_CARD_KEY))
  const fs = narrow ? 2 : 0
  const lineH = COST_PANEL.lineHeight + (narrow ? 6 : 0)
  const headerH = COST_PANEL.headerHeight
  const sectionGap = COST_PANEL.sectionGap
  const agentRows = rows.length + (rest ? 1 : 0)
  const toolRows = Math.min(toolList.length, COST_PANEL.maxRows)
  const panelH = headerH + (agentRows * lineH) + sectionGap + (toolRows > 0 ? 14 + toolRows * lineH : 0) + 12

  publishCostCardInset(narrow, panelY + panelH, panelW + margin)

  ctx.save()

  // Panel background
  ctx.fillStyle = COLORS.panelBg
  ctx.strokeStyle = COLORS.glassBorder
  ctx.lineWidth = 1
  ctx.beginPath()
  ctx.roundRect(panelX, panelY, panelW, panelH, COST_PANEL.borderRadius)
  ctx.fill()
  ctx.stroke()

  let y = panelY + 8

  // Header: total cost
  ctx.font = FONT.mono(12 + fs, 'bold')
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = COLORS.costText
  ctx.fillText(`$${totalCost.toFixed(3)}`, panelX + COST_PANEL.contentPadding, y)

  ctx.font = FONT.mono(10 + fs)
  ctx.fillStyle = COLORS.textMuted
  ctx.fillText(`${formatTokens(totalTokens)} tokens`, panelX + COST_PANEL.contentPadding + ctx.measureText(`$${totalCost.toFixed(3)}`).width + 14, y + 2)

  y += headerH

  // Per-agent breakdown
  const barW = panelW - COST_PANEL.contentPadding * 2
  for (let i = 0; i < agentRows; i++) {
    const a = i < rows.length ? rows[i] : { name: rest!.label, isMain: false, cost: rest!.cost }

    // Mini bar background
    const ratio = totalCost > 0 ? a.cost / totalCost : 0
    ctx.fillStyle = COLORS.holoBorder06
    ctx.beginPath()
    ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW, lineH - 3, COST_PANEL.barRadius)
    ctx.fill()

    // Bar fill
    ctx.fillStyle = a.isMain || a.name.includes('main') || agentBreakdown.length === 1
      ? COLORS.barFillMain
      : COLORS.barFillSub
    ctx.beginPath()
    ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW * ratio, lineH - 3, COST_PANEL.barRadius)
    ctx.fill()

    // Status glyph (non-colour cue) + agent name + model tag + cost
    const rowFont = narrow ? 11 : 9
    const rowMid = y + 1 + (lineH - 3) / 2
    const barLeft = panelX + COST_PANEL.contentPadding + COST_PANEL.barInset
    const barRight = panelX + COST_PANEL.contentPadding + barW - COST_PANEL.barInset
    const isRest = i >= rows.length
    const status: CostRowStatus = isRest ? 'removed' : rows[i].status
    const model = isRest ? undefined : rows[i].model
    if (i > 0 && status !== 'running' && rows[i - 1]?.status === 'running') {
      ctx.fillStyle = COLORS.glassBorder
      ctx.fillRect(panelX + COST_PANEL.contentPadding, y - 2, barW, 1)
    }
    drawStatusGlyph(ctx, status, barLeft + 4, rowMid, narrow ? 4 : 3, performance.now())

    ctx.font = FONT.mono(rowFont)
    const costText = `$${a.cost.toFixed(3)}`
    const costW = ctx.measureText(costText).width
    const tag = modelTag(model)
    ctx.font = FONT.mono(rowFont - 1, 'bold')
    const tagW = tag ? ctx.measureText(tag).width : 0
    const nameX = barLeft + 14
    const nameMax = barRight - costW - (tag ? tagW + 6 : 0) - 8 - nameX

    ctx.font = FONT.mono(rowFont)
    ctx.fillStyle = status === 'running' ? COLORS.textPrimary : COLORS.textMuted
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillText(truncateText(ctx, a.name, Math.max(20, nameMax)), nameX, rowMid)

    ctx.textAlign = 'right'
    ctx.fillStyle = COLORS.costText
    ctx.fillText(costText, barRight, rowMid)
    if (tag) {
      ctx.font = FONT.mono(rowFont - 1, 'bold')
      ctx.fillStyle = getAgentGroupColor({ isMain: false, model })
      ctx.fillText(tag, barRight - costW - 6, rowMid)
    }
    ctx.textBaseline = 'top'

    y += lineH
  }

  // Per-tool-type breakdown
  if (toolList.length > 0) {
    y += sectionGap

    ctx.font = FONT.mono(9 + fs)
    ctx.fillStyle = COLORS.textMuted
    ctx.textAlign = 'left'
    ctx.fillText('BY TOOL', panelX + COST_PANEL.contentPadding, y)
    y += 14 + fs

    for (let i = 0; i < toolRows; i++) {
      const t = toolList[i]
      const ratio = totalCost > 0 ? t.cost / totalCost : 0

      // Background
      ctx.fillStyle = COLORS.panelSeparator
      ctx.beginPath()
      ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW, lineH - 3, COST_PANEL.barRadius)
      ctx.fill()

      // Fill
      ctx.fillStyle = toolTypeColor(t.name)
      ctx.globalAlpha = 0.2
      ctx.beginPath()
      ctx.roundRect(panelX + COST_PANEL.contentPadding, y + 1, barW * ratio, lineH - 3, COST_PANEL.barRadius)
      ctx.fill()
      ctx.globalAlpha = 1

      // Tool name
      ctx.font = FONT.mono(9 + fs)
      ctx.fillStyle = toolTypeColor(t.name)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'middle'
      const rowMid = y + 1 + (lineH - 3) / 2
      ctx.fillText(truncateText(ctx, t.name, barW - 60), panelX + COST_PANEL.contentPadding + COST_PANEL.barInset, rowMid)

      // Cost
      ctx.textAlign = 'right'
      ctx.fillStyle = COLORS.costTextDim
      ctx.fillText(`$${t.cost.toFixed(3)}`, panelX + COST_PANEL.contentPadding + barW - COST_PANEL.barInset, rowMid)
      ctx.textBaseline = 'top'

      y += lineH
    }
  }

  ctx.restore()
}
