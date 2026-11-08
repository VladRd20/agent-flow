'use client'

import { useEffect, useState } from 'react'
import { CARD, Z, type AgentState } from '@/lib/agent-types'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useFocusReturn } from '@/hooks/use-focus-return'
import { COLORS, getStateColor } from '@/lib/colors'
import { formatTokens, formatModelName } from '@/lib/utils'
import { GlassCard } from './glass-card'
import { PanelHeader, ProgressBar } from './shared-ui'

interface AgentDetailCardProps {
  agent: {
    id: string
    name: string
    state: AgentState
    model?: string
    tokensUsed: number
    tokensMax: number
    toolCalls: number
    timeAlive: number
    currentTool?: string
  }
  onClose: () => void
  /** All view only: switch to this node's own session tab */
  onOpenSession?: () => void
}

export function AgentDetailCard({
  agent,
  onClose,
  onOpenSession,
}: AgentDetailCardProps) {
  const contextPercent = Math.round((agent.tokensUsed / agent.tokensMax) * 100)
  const stateColor = getStateColor(agent.state)

  const isMobile = useIsMobile()
  useFocusReturn(true)
  // State (not a ref object): GlassCard mounts its element a tick after this component,
  // so the effect below must re-run once the element exists or --af-detail-h stays 0.
  const [cardEl, setCardEl] = useState<HTMLDivElement | null>(null)

  // Track the viewport height so the card re-centers on resize / rotation
  const [viewportH, setViewportH] = useState(() => typeof window !== 'undefined' ? window.innerHeight : 600)
  useEffect(() => {
    const update = () => setViewportH(window.visualViewport?.height ?? window.innerHeight)
    update()
    window.addEventListener('resize', update)
    window.addEventListener('orientationchange', update)
    window.visualViewport?.addEventListener('resize', update)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('orientationchange', update)
      window.visualViewport?.removeEventListener('resize', update)
    }
  }, [])

  // Mobile: publish the sheet's height so the chat sheet can stack above it
  useEffect(() => {
    const root = document.documentElement
    const el = cardEl
    if (!isMobile || !el) {
      root.style.setProperty('--af-detail-h', '0px')
      return
    }
    const publish = () => root.style.setProperty('--af-detail-h', `${Math.round(el.getBoundingClientRect().height)}px`)
    publish()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null
    ro?.observe(el)
    return () => {
      ro?.disconnect()
      root.style.setProperty('--af-detail-h', '0px')
    }
  }, [isMobile, cardEl, agent.currentTool])

  // Desktop: fixed position, middle-left of the screen (below message feed panel)
  const left = CARD.margin
  const top = Math.max(100, (viewportH - CARD.detail.height) / 2)

  const style: React.CSSProperties = isMobile
    ? {
        // Mobile: bottom sheet that scrolls when the viewport is short (landscape)
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: Z.sheet,
        overflowY: 'auto',
        overscrollBehavior: 'contain',
        borderRadius: '12px 12px 0 0',
      }
    : { position: 'absolute', left, top, width: CARD.detail.width, zIndex: Z.detailCard }

  return (
    <GlassCard
      visible={true}
      innerRef={setCardEl}
      role="dialog"
      aria-label={`${agent.name} details`}
      className={`agent-detail-card${isMobile ? ' af-sheet af-mh-detail' : ''}`}
      style={style}
    >
      <PanelHeader onClose={onClose} className="mb-3">
        <div
          className="w-2 h-2 rounded-full"
          style={{ background: stateColor, boxShadow: `0 0 8px ${stateColor}` }}
        />
        <div className="flex flex-col min-w-0">
          <span className="text-xs font-mono truncate" title={agent.name} style={{ color: COLORS.textPrimary }}>
            {agent.name}
          </span>
          {agent.model && (
            <span className="text-[9px] font-mono" style={{ color: COLORS.textDim }}>
              {formatModelName(agent.model)}
            </span>
          )}
        </div>
      </PanelHeader>

      {/* Context bar */}
      <div className="mb-3">
        <div className="flex justify-between mb-1">
          <span className="text-[10px]" style={{ color: COLORS.textMuted }}>Context</span>
          <span className="text-[10px] font-mono" style={{ color: COLORS.textDim }}>
            {formatTokens(agent.tokensUsed)} / {formatTokens(agent.tokensMax)} ({contextPercent}%)
          </span>
        </div>
        <ProgressBar percent={contextPercent} color={stateColor} />
      </div>

      {/* Stats row */}
      <div className="flex flex-wrap gap-x-3 gap-y-1 mb-3 text-[10px] font-mono" style={{ color: COLORS.textDim }}>
        <span>{agent.toolCalls} tools</span>
        <span>{agent.timeAlive.toFixed(1)}s alive</span>
        <span className="capitalize" style={{ color: stateColor }}>{agent.state}</span>
      </div>

      {onOpenSession && (
        <button
          type="button"
          onClick={onOpenSession}
          className="af-hit mb-3 px-2 py-1 rounded text-[10px] font-mono"
          style={{ background: COLORS.tabInactiveBg, border: `1px solid ${COLORS.tabSelectedBorder}`, color: COLORS.holoBright }}
        >
          Open session
        </button>
      )}

      {/* Current tool */}
      {agent.currentTool && (
        <div
          className="mb-3 px-2 py-1.5 rounded text-[10px] font-mono flex items-center gap-2"
          style={{
            background: COLORS.toolIndicatorBg,
            border: `1px solid ${COLORS.toolIndicatorBorder}`,
            color: COLORS.toolIndicatorText,
          }}
        >
          <span className="animate-spin inline-block">⚙</span>
          {agent.currentTool}
        </div>
      )}

    </GlassCard>
  )
}
