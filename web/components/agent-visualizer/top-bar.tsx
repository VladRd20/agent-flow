"use client"

import { memo, useCallback, useRef, useState } from "react"
import { Z } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"
import { formatTokens } from "@/lib/utils"
import { agentCost } from "./canvas/draw-cost"
import { SessionTabs } from "./session-tabs"
import type { SessionInfo, ConnectionStatus } from "@/lib/bridge-types"
import { useIsMobile } from "@/hooks/use-is-mobile"
import { useClickOutside } from "@/hooks/use-click-outside"
import { useEscapeKey } from "@/hooks/use-escape-key"
import { useTopChromeInset } from "@/hooks/use-top-chrome-inset"

// ─── Mute/Unmute SVG Icons ───────────────────────────────────────────────────

function MutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <line x1="23" y1="9" x2="17" y2="15" />
      <line x1="17" y1="9" x2="23" y2="15" />
    </svg>
  )
}

function UnmutedIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  )
}

// ─── Toggle Button ──────────────────────────────────────────────────────────

function ToggleButton({ active, onClick, children, style, activeColor, label }: {
  active: boolean
  label?: string
  onClick: () => void
  children: React.ReactNode
  style?: React.CSSProperties
  activeColor?: { bg: string; text: string }
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      aria-label={label}
      className="af-hit px-1.5 py-0.5 rounded transition-all"
      style={{
        background: active ? (activeColor?.bg ?? COLORS.toggleActive) : COLORS.toggleInactive,
        border: `1px solid ${COLORS.toggleBorder}`,
        color: active ? (activeColor?.text ?? COLORS.holoBright) : COLORS.textMuted,
        ...style,
      }}
    >
      {children}
    </button>
  )
}

// ─── Connection Status Indicator ────────────────────────────────────────────

function connectionMeta(status: ConnectionStatus) {
  const color = status === 'watching' ? COLORS.complete
    : status === 'connected' ? COLORS.idle : COLORS.error
  const label = status === 'watching' ? 'LIVE'
    : status === 'connected' ? 'CONNECTED' : 'OFFLINE'
  return { color, label }
}

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const { color, label } = connectionMeta(status)

  return (
    <span className="flex items-center gap-1.5" role="status">
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 4px ${color}` }}
      />
      {label}
    </span>
  )
}

/** Tiny dot-only variant for the cramped mobile bar. */
function ConnectionDot({ status }: { status: ConnectionStatus }) {
  const { color, label } = connectionMeta(status)
  return (
    <span
      role="status"
      aria-label={`Connection: ${label}`}
      title={label}
      className="flex-shrink-0 w-2 h-2 rounded-full"
      style={{ background: color, boxShadow: `0 0 4px ${color}` }}
    />
  )
}

// ─── Top Bar ────────────────────────────────────────────────────────────────

export interface TopBarProps {
  // Session tabs
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
  // Connection
  isVSCode: boolean
  connectionStatus: ConnectionStatus
  // Stats
  agentCount: number
  /** Hidden (finished, not yet expired) agents available as ghosts */
  finishedCount: number
  showFinished: boolean
  onToggleFinished: () => void
  totalTokens: number
  // Panel toggles
  showFileAttention: boolean
  showTranscript: boolean
  showCostOverlay: boolean
  showTimeline: boolean
  isMuted: boolean
  onTogglePanel: (panel: 'files' | 'transcript' | 'cost') => void
  onToggleTimeline: () => void
  onToggleMute: () => void
}

export const TopBar = memo(function TopBar(props: TopBarProps) {
  const isMobile = useIsMobile()
  if (isMobile) return <MobileTopBar {...props} />
  return <DesktopTopBar {...props} />
})

// ─── Desktop Top Bar (unchanged) ────────────────────────────────────────────

function DesktopTopBar({
  sessions, selectedSessionId, sessionsWithActivity,
  onSelectSession, onCloseSession,
  connectionStatus,
  agentCount, finishedCount, showFinished, onToggleFinished, totalTokens,
  showFileAttention, showTranscript, showCostOverlay, showTimeline, isMuted,
  onTogglePanel, onToggleTimeline, onToggleMute,
}: TopBarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  useTopChromeInset('top-bar', barRef)
  return (
    <div
      ref={barRef}
      className="absolute flex items-center gap-4 font-mono text-[10px] pointer-events-none"
      style={{ top: 'var(--af-top)', left: 'var(--af-left)', right: 'var(--af-right)', zIndex: Z.topBar }}
    >
      {/* Session tabs — scrollable, takes available space */}
      {sessions.length > 0 && (
        <div className="min-w-0 flex-shrink pointer-events-auto">
          <SessionTabs
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionsWithActivity={sessionsWithActivity}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
          />
        </div>
      )}

      {/* Spacer pushes info to the right */}
      <div className="flex-1" />

      {/* Right-side info/controls */}
      <div className="flex items-center gap-4 flex-shrink-0 pointer-events-auto" style={{ color: COLORS.textMuted }}>
        <ConnectionIndicator status={connectionStatus} />
        <span>
          {agentCount} agents
          {finishedCount > 0 && <span style={{ opacity: 0.6, marginLeft: 4 }}>+{finishedCount} finished</span>}
        </span>
        <span>
          {formatTokens(totalTokens)} tokens
          <span style={{ color: COLORS.complete + '65', marginLeft: 4 }}>
            ~${agentCost(totalTokens).toFixed(2)}
          </span>
        </span>

        {/* Mutually exclusive panel group */}
        <div role="group" aria-label="Panels" className="flex items-center gap-1 px-1 py-0.5 rounded" style={{
          background: COLORS.holoBg03,
          border: `1px solid ${COLORS.holoBorder06}`,
        }}>
          <ToggleButton active={showFileAttention} onClick={() => onTogglePanel('files')} style={{ background: showFileAttention ? undefined : 'transparent', border: 'none' }}>Files</ToggleButton>
          <ToggleButton active={showTranscript} onClick={() => onTogglePanel('transcript')} style={{ background: showTranscript ? undefined : 'transparent', border: 'none' }}>Chat</ToggleButton>
          <ToggleButton
            active={showCostOverlay}
            onClick={() => onTogglePanel('cost')}
            activeColor={{ bg: COLORS.costActiveBg, text: COLORS.complete }}
            style={{ background: showCostOverlay ? undefined : 'transparent', border: 'none' }}
          >
            $Cost
          </ToggleButton>
        </div>

        {/* Independent toggles */}
        <ToggleButton active={showTimeline} onClick={onToggleTimeline}>Timeline</ToggleButton>
        <ToggleButton active={showFinished} onClick={onToggleFinished} label="Show finished agents">Finished</ToggleButton>
        <ToggleButton active={!isMuted} onClick={onToggleMute} label={isMuted ? 'Unmute' : 'Mute'} style={{ border: `1px solid ${COLORS.toggleBorder}` }}>
          {isMuted ? <MutedIcon /> : <UnmutedIcon />}
        </ToggleButton>
      </div>
    </div>
  )
}

// ─── Mobile Top Bar ─────────────────────────────────────────────────────────
// Collapses the right-side toggle group into a tap-to-open menu so the bar
// never overflows a narrow viewport. Session tabs stay inline/scrollable.

function MobileTopBar({
  sessions, selectedSessionId, sessionsWithActivity,
  onSelectSession, onCloseSession,
  connectionStatus,
  agentCount, finishedCount, showFinished, onToggleFinished, totalTokens,
  showFileAttention, showTranscript, showCostOverlay, showTimeline, isMuted,
  onTogglePanel, onToggleTimeline, onToggleMute,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const closeMenu = useCallback(() => setMenuOpen(false), [])
  useClickOutside(menuRef, closeMenu)
  useEscapeKey(closeMenu, menuOpen)
  const barRef = useRef<HTMLDivElement>(null)
  useTopChromeInset('top-bar', barRef)

  return (
    <div
      ref={barRef}
      className="absolute flex items-center gap-2 font-mono text-[10px] pointer-events-none"
      style={{
        top: 'var(--af-top)',
        left: 'var(--af-left)',
        right: 'var(--af-right)',
        height: 'var(--af-top-bar-h)',
        zIndex: Z.topBar,
      }}
    >
      {sessions.length > 0 && (
        <div className="min-w-0 flex-1 pointer-events-auto">
          <SessionTabs
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionsWithActivity={sessionsWithActivity}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
          />
        </div>
      )}

      <div ref={menuRef} className="relative flex-shrink-0 flex items-center gap-2 ml-auto pointer-events-auto">
        <ConnectionDot status={connectionStatus} />
        <button
          type="button"
          onClick={() => setMenuOpen(o => !o)}
          className="flex items-center justify-center rounded"
          aria-label="Menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          style={{
            width: 44,
            height: 44,
            background: menuOpen ? COLORS.toggleActive : COLORS.toggleInactive,
            border: `1px solid ${COLORS.toggleBorder}`,
            color: menuOpen ? COLORS.holoBright : COLORS.textMuted,
            fontSize: 18,
          }}
        >
          ☰
        </button>

        {menuOpen && (
          <div
            role="menu"
            aria-label="Panels"
            className="absolute right-0 rounded flex flex-col gap-1 p-2"
            style={{
              top: '100%',
              marginTop: 4,
              minWidth: 200,
              maxWidth: 'calc(100vw - 16px)',
              // short (landscape) screens: scroll the menu instead of running off the bottom
              maxHeight: 'calc(100vh - var(--af-sheet-top) - 8px)',
              overflowY: 'auto',
              overscrollBehavior: 'contain',
              background: 'rgba(10, 15, 30, 0.92)',
              backdropFilter: 'blur(8px)',
              WebkitBackdropFilter: 'blur(8px)',
              border: `1px solid ${COLORS.holoBorder06}`,
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            }}
          >
            <div className="flex items-center justify-between gap-3 px-1 py-1" style={{ color: COLORS.textMuted }}>
              <ConnectionIndicator status={connectionStatus} />
              <span className="whitespace-nowrap">
                {agentCount} agents
                {finishedCount > 0 && <span style={{ opacity: 0.6, marginLeft: 4 }}>+{finishedCount} finished</span>}
              </span>
            </div>
            <div className="px-1 pb-1" style={{ color: COLORS.textMuted }}>
              {formatTokens(totalTokens)} tokens
              <span style={{ color: COLORS.complete + '65', marginLeft: 4 }}>
                ~${agentCost(totalTokens).toFixed(2)}
              </span>
            </div>

            <MobileMenuToggle label="Files" active={showFileAttention} onClick={() => { onTogglePanel('files'); closeMenu() }} />
            <MobileMenuToggle label="Chat" active={showTranscript} onClick={() => { onTogglePanel('transcript'); closeMenu() }} />
            <MobileMenuToggle
              label="$Cost"
              active={showCostOverlay}
              onClick={() => { onTogglePanel('cost'); closeMenu() }}
              activeColor={{ bg: COLORS.costActiveBg, text: COLORS.complete }}
            />
            <MobileMenuToggle label="Timeline" active={showTimeline} onClick={() => { onToggleTimeline(); closeMenu() }} />
            <MobileMenuToggle label="Show finished" active={showFinished} onClick={() => { onToggleFinished(); closeMenu() }} />
            <MobileMenuToggle label={isMuted ? 'Unmute' : 'Mute'} active={!isMuted} onClick={() => { onToggleMute(); closeMenu() }} />
          </div>
        )}
      </div>
    </div>
  )
}

function MobileMenuToggle({ label, active, onClick, activeColor }: {
  label: string
  active: boolean
  onClick: () => void
  activeColor?: { bg: string; text: string }
}) {
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={active}
      onClick={onClick}
      className="text-left px-3 min-h-11 flex items-center rounded transition-all"
      style={{
        background: active ? (activeColor?.bg ?? COLORS.toggleActive) : 'transparent',
        color: active ? (activeColor?.text ?? COLORS.holoBright) : COLORS.textMuted,
      }}
    >
      {label}
    </button>
  )
}
