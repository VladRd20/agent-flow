'use client'

import { useRef } from 'react'
import { Z, TIMING, CARD } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { GlassCard } from './glass-card'
import { useClickOutside } from '@/hooks/use-click-outside'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { stopPropagationHandlers } from './shared-ui'

/** Approximate width used only to keep the menu on-screen on narrow viewports (below) */
const ESTIMATED_MENU_WIDTH = 180

interface ContextMenuProps {
  position: { x: number; y: number }
  items: Array<{
    label: string
    onClick: () => void
    danger?: boolean
    separator?: boolean
  }>
  onClose: () => void
}

export function GlassContextMenu({ position, items, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const isMobile = useIsMobile()

  useClickOutside(ref, onClose, TIMING.contextMenuDelayMs)

  // On mobile, clamp so a long-press/right-click near a screen edge doesn't
  // render the menu partially or fully off-screen. Desktop keeps the exact
  // original unclamped positioning.
  const left = isMobile && typeof window !== 'undefined'
    ? Math.min(position.x, window.innerWidth - ESTIMATED_MENU_WIDTH - CARD.margin)
    : position.x
  const top = isMobile && typeof window !== 'undefined'
    ? Math.min(position.y, window.innerHeight - CARD.margin)
    : position.y

  return (
    <div
      ref={ref}
      {...stopPropagationHandlers}
      style={{
        position: 'fixed',
        left,
        top,
        zIndex: Z.contextMenu,
      }}
    >
      <GlassCard
        visible={true}
        style={{ minWidth: 160 }}
      >
        <div className="py-1">
          {items.map((item, i) =>
            item.separator ? (
              <div key={i} className="my-1 h-px" style={{ background: COLORS.holoBg10 }} />
            ) : (
              <button
                key={i}
                onClick={() => {
                  item.onClick()
                  onClose()
                }}
                className="w-full px-3 py-1.5 text-left text-[11px] font-mono transition-colors hover:bg-white/5"
                style={{ color: item.danger ? COLORS.error : COLORS.textPrimary }}
              >
                {item.label}
              </button>
            )
          )}
        </div>
      </GlassCard>
    </div>
  )
}
