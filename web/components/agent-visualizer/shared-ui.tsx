'use client'

import { useRef, type ReactNode } from 'react'
import { Z } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { useClickOutside } from '@/hooks/use-click-outside'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useEscapeKey } from '@/hooks/use-escape-key'
import { clampPopupPosition } from '@/lib/clamp-popup-position'
import { GlassCard } from './glass-card'

// ─── Stop Propagation Handlers ──────────────────────────────────────────────
// Prevents canvas drag/click events from firing when interacting with panels

export const stopPropagationHandlers = {
  onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
  onMouseUp: (e: React.MouseEvent) => e.stopPropagation(),
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
} as const

// ─── Close Button ───────────────────────────────────────────────────────────

interface CloseButtonProps {
  onClick: () => void
  className?: string
  label?: string
}

export function CloseButton({ onClick, className = '', label = 'Close' }: CloseButtonProps) {
  const isMobile = useIsMobile()
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`af-hit transition-colors ${isMobile ? 'min-w-11 min-h-11 flex items-center justify-center text-sm' : 'text-xs px-1.5 py-0.5'} ${className}`}
      style={{ color: COLORS.textMuted }}
    >
      ✕
    </button>
  )
}

// ─── Panel Header ───────────────────────────────────────────────────────────

interface PanelHeaderProps {
  children: ReactNode
  onClose: () => void
  className?: string
  actions?: ReactNode
}

export function PanelHeader({ children, onClose, className = 'mb-2', actions }: PanelHeaderProps) {
  return (
    <div className={`flex items-center justify-between ${className}`}>
      <div className="flex items-center gap-2 min-w-0">
        {children}
      </div>
      <div className="flex items-center gap-1">
        {actions}
        <CloseButton onClick={onClose} />
      </div>
    </div>
  )
}

// ─── Detail Popup ──────────────────────────────────────────────────────────
// Shared wrapper for popup detail cards (tool detail, discovery detail, etc.)

interface DetailPopupProps {
  position: { x: number; y: number }
  width: number
  estimatedHeight: number
  onClose: () => void
  children: ReactNode
}

export function DetailPopup({ position, width, estimatedHeight, onClose, children }: DetailPopupProps) {
  const ref = useRef<HTMLDivElement>(null)
  const { left, top } = clampPopupPosition(position, width, estimatedHeight)

  useClickOutside(ref, onClose)
  useEscapeKey(onClose)

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label="Details"
      {...stopPropagationHandlers}
      style={{ position: 'absolute', left, top, width, zIndex: Z.detailCard }}
    >
      <GlassCard visible={true}>
        {children}
      </GlassCard>
    </div>
  )
}

// ─── Sliding Panel ──────────────────────────────────────────────────────────
// Shared wrapper for panels that slide in/out with a visibility transition.

interface SlidingPanelProps {
  visible: boolean
  /** CSS positioning — e.g. { top: 12, right: 3 } */
  position: React.CSSProperties
  /** Slide direction: 'X' slides horizontally, 'Y' slides vertically */
  axis?: 'X' | 'Y'
  /** Pixel offset when hidden (default 20) */
  offset?: number
  zIndex: number
  width?: number | string
  className?: string
  style?: React.CSSProperties
  children: ReactNode
  /**
   * Optional overrides applied only when the viewport is at/below the mobile
   * breakpoint — e.g. turning a floating side panel into a full-screen sheet.
   * When omitted, mobile viewports render identically to desktop (unchanged).
   */
  mobilePosition?: React.CSSProperties
  mobileWidth?: number | string
  mobileClassName?: string
  mobileStyle?: React.CSSProperties
  /** Slide axis to use on mobile only; defaults to `axis` when omitted (desktop unaffected). */
  mobileAxis?: 'X' | 'Y'
  /** z-index to use on mobile only (sheets sit above the control bar) */
  mobileZIndex?: number
  /** Accessible name; renders the panel as role="dialog" */
  label?: string
  /** Closes the panel on Escape; on mobile also renders a tap-to-close backdrop behind it */
  onDismiss?: () => void
  /** Render the dimming backdrop on mobile (default true when onDismiss is given). Escape works either way. */
  mobileBackdrop?: boolean
}

export function SlidingPanel({
  visible, position, axis = 'X', offset = 20,
  zIndex, width, className = '', style, children,
  mobilePosition, mobileWidth, mobileClassName, mobileStyle, mobileAxis,
  mobileZIndex, label, onDismiss, mobileBackdrop = true,
}: SlidingPanelProps) {
  const isMobile = useIsMobile()
  const useMobileOverrides = isMobile && (mobilePosition || mobileWidth !== undefined || mobileClassName || mobileStyle || mobileAxis)
  const effectivePosition = useMobileOverrides && mobilePosition ? mobilePosition : position
  const effectiveWidth = useMobileOverrides && mobileWidth !== undefined ? mobileWidth : width
  const effectiveClassName = useMobileOverrides && mobileClassName ? `${className} ${mobileClassName}` : className
  const effectiveStyle = useMobileOverrides && mobileStyle ? { ...style, ...mobileStyle } : style
  const effectiveAxis = useMobileOverrides && mobileAxis ? mobileAxis : axis
  const effectiveZ = isMobile && mobileZIndex !== undefined ? mobileZIndex : zIndex

  useEscapeKey(() => onDismiss?.(), visible && !!onDismiss)

  return (
    <>
      {isMobile && visible && onDismiss && mobileBackdrop && (
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{ zIndex: Z.sheetBackdrop, background: 'rgba(4, 6, 16, 0.55)', touchAction: 'none' }}
          onClick={onDismiss}
        />
      )}
      <div
        role={label ? 'dialog' : undefined}
        aria-label={label}
        aria-hidden={visible ? undefined : true}
        className={`absolute transition-all duration-300 ${effectiveClassName}`}
        style={{
          ...effectivePosition,
          opacity: visible ? 1 : 0,
          transform: `translate${effectiveAxis}(${visible ? 0 : offset}px)`,
          pointerEvents: visible ? 'auto' : 'none',
          zIndex: effectiveZ,
          width: effectiveWidth,
          ...effectiveStyle,
        }}
      >
        {children}
      </div>
    </>
  )
}

// ─── Progress Bar ───────────────────────────────────────────────────────────

interface ProgressBarProps {
  percent: number
  color: string
  trackColor?: string
}

export function ProgressBar({ percent, color, trackColor = COLORS.holoBg10 }: ProgressBarProps) {
  return (
    <div className="h-1 rounded-full overflow-hidden" style={{ background: trackColor }}>
      <div
        className="h-full rounded-full transition-all duration-500"
        style={{
          width: `${percent}%`,
          background: color,
          boxShadow: `0 0 6px ${color}40`,
        }}
      />
    </div>
  )
}
