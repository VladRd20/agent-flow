"use client"

import { memo, useEffect, useState } from "react"
import { COLORS } from "@/lib/colors"
import { COST_TOTAL_TOOLTIP, costSummarySentence, formatCompactTokens, formatCostUsd } from "@/lib/cost-summary"

/** Always-visible session cost chip (DOM text, so it can be selected, zoomed and read by AT).
 *  Tapping it toggles the canvas cost card. Figures come from the cumulative usage ledger. */
export const CostChip = memo(function CostChip({ cost, tokens, active, onToggle, compact }: {
  cost: number
  tokens: number
  active: boolean
  onToggle: () => void
  /** Phones: drop the token count below ~380px so the tab strip keeps its room. */
  compact?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={active}
      aria-label={`${costSummarySentence(cost, tokens)}. Toggle cost breakdown`}
      title={`Total cost. ${COST_TOTAL_TOOLTIP}. Click to toggle breakdown`}
      className="af-hit flex items-center gap-1 rounded px-1.5 py-0.5 whitespace-nowrap"
      style={{
        fontVariantNumeric: 'tabular-nums',
        background: active ? COLORS.costActiveBg : COLORS.toggleInactive,
        border: `1px solid ${COLORS.toggleBorder}`,
        color: active ? COLORS.complete : COLORS.costText,
        minHeight: compact ? 32 : undefined,
      }}
    >
      <span aria-hidden="true">{formatCostUsd(cost)}</span>
      <span
        aria-hidden="true"
        className={compact ? 'hidden min-[380px]:inline' : undefined}
        style={{ color: COLORS.textMuted }}
      >
        · {formatCompactTokens(tokens)} tok
      </span>
    </button>
  )
})

const VISUALLY_HIDDEN: React.CSSProperties = {
  position: 'absolute', width: 1, height: 1, margin: -1, padding: 0,
  overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap', border: 0,
}

/** Debounced screen-reader mirror of the cost totals. The text only updates after the
 *  figures have been stable for `delayMs`, so a ticking session is not announced per tick. */
export const CostLiveSummary = memo(function CostLiveSummary({ cost, tokens, delayMs = 3000 }: {
  cost: number
  tokens: number
  delayMs?: number
}) {
  const [text, setText] = useState(() => costSummarySentence(cost, tokens))
  useEffect(() => {
    const next = costSummarySentence(cost, tokens)
    const t = setTimeout(() => setText(next), delayMs)
    return () => clearTimeout(t)
  }, [cost, tokens, delayMs])
  return <div role="status" style={VISUALLY_HIDDEN}>{text}</div>
})
