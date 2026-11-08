"use client"

import { memo, useEffect, useRef } from "react"
import { Z } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"
import { useIsMobile } from "@/hooks/use-is-mobile"
import { setLeftInset, setFitBottomInset, setKeepOut } from "@/lib/layout-insets"

interface ViewControlsProps {
  /** Hide while a mobile sheet is open (keeps state, drops out of layout/hit-testing) */
  hidden?: boolean
  /** With `hidden`, still show in landscape phones (the agent sheets leave room for the row) */
  keepInLandscape?: boolean
  frozen: boolean
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
  onFocusNext: () => void
  onToggleFreeze: () => void
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  )
}

function ViewButton({ label, onClick, pressed, size, children }: {
  label: string
  onClick: () => void
  pressed?: boolean
  size: string
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`af-hit ${size} rounded flex items-center justify-center transition-all`}
      style={{
        background: pressed ? COLORS.toggleActive : COLORS.toggleInactive,
        border: `1px solid ${COLORS.toggleBorder}`,
        color: pressed ? COLORS.holoBright : COLORS.textMuted,
      }}
    >
      {children}
    </button>
  )
}

/** Single-pointer alternatives to pinch/drag (zoom in/out/fit, focus next running agent) plus the freeze-layout toggle.
 *  Sits bottom-left above the control bar; 44px targets on phones. */
export const ViewControls = memo(function ViewControls({
  hidden, keepInLandscape, frozen, onZoomIn, onZoomOut, onFit, onFocusNext, onToggleFreeze,
}: ViewControlsProps) {
  const isMobile = useIsMobile()
  const size = isMobile ? 'w-11 h-11' : 'w-9 h-9'
  const ref = useRef<HTMLDivElement>(null)
  // Publish where the buttons sit: fit-to-view keeps cards clear of them (phones), and bubbles /
  // tool cards route around them (all sizes). Column = portrait phone, row = landscape phone.
  useEffect(() => {
    const el = ref.current
    const clear = () => {
      setLeftInset('view-controls', 0)
      setFitBottomInset('view-controls', 0)
      setKeepOut('view-controls', null)
    }
    if (!el) { clear(); return }
    const publish = () => {
      const r = el.getBoundingClientRect()
      if (r.width <= 0 || r.height <= 0) { clear(); return }
      setKeepOut('view-controls', { x: r.left, y: r.top, w: r.width, h: r.height })
      if (!isMobile) { setLeftInset('view-controls', 0); setFitBottomInset('view-controls', 0); return }
      if (r.width > r.height) {
        // Row (landscape): cards must end above its top edge
        setLeftInset('view-controls', 0)
        setFitBottomInset('view-controls', window.innerHeight - r.top + 24)
      } else {
        setFitBottomInset('view-controls', 0)
        setLeftInset('view-controls', r.right + 8)
      }
    }
    publish()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null
    ro?.observe(el)
    window.addEventListener('resize', publish)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', publish)
      clear()
    }
  }, [isMobile, hidden, keepInLandscape])
  return (
    <div
      ref={ref}
      role="group"
      aria-label="View controls"
      className={`absolute flex flex-col gap-1 [@media(max-height:500px)]:flex-row ${hidden && keepInLandscape ? 'af-vc-portrait-hide' : ''}`}
      style={{
        left: 'var(--af-edge-left)',
        bottom: 'calc(var(--af-above-bar) + 8px)',
        zIndex: Z.controlBar,
        display: hidden && !keepInLandscape ? 'none' : undefined,
        pointerEvents: hidden && !keepInLandscape ? 'none' : 'auto',
      }}
    >
      <ViewButton label="Zoom in" onClick={onZoomIn} size={size}>
        <Icon><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></Icon>
      </ViewButton>
      <ViewButton label="Zoom out" onClick={onZoomOut} size={size}>
        <Icon><line x1="5" y1="12" x2="19" y2="12" /></Icon>
      </ViewButton>
      <ViewButton label="Fit graph to view" onClick={onFit} size={size}>
        <Icon><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" /></Icon>
      </ViewButton>
      <ViewButton label="Focus next running agent" onClick={onFocusNext} size={size}>
        <Icon><circle cx="12" cy="12" r="3" /><circle cx="12" cy="12" r="8" /></Icon>
      </ViewButton>
      <ViewButton
        label={frozen ? "Unfreeze layout" : "Freeze layout"}
        pressed={frozen}
        onClick={onToggleFreeze}
        size={size}
      >
        <Icon><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></Icon>
      </ViewButton>
    </div>
  )
})
