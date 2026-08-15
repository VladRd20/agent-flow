"use client"

import { memo, useRef, useState } from "react"
import { Z } from "@/lib/agent-types"
import { COLORS } from "@/lib/colors"
import { formatTokens } from "@/lib/utils"
import { agentCost } from "./canvas/draw-cost"
import { SessionTabs } from "./session-tabs"
import type { SessionInfo, ConnectionStatus } from "@/lib/bridge-types"
import { useIsMobile } from "@/hooks/use-is-mobile"
import { useClickOutside } from "@/hooks/use-click-outside"

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

function ToggleButton({ active, onClick, children, style, activeColor }: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
  style?: React.CSSProperties
  activeColor?: { bg: string; text: string }
}) {
  return (
    <button
      onClick={onClick}
      className="px-1.5 py-0.5 rounded transition-all"
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

function ConnectionIndicator({ status }: { status: ConnectionStatus }) {
  const color = status === 'watching' ? COLORS.complete
    : status === 'connected' ? COLORS.idle : COLORS.error
  const label = status === 'watching' ? 'LIVE'
    : status === 'connected' ? 'CONNECTED' : 'OFFLINE'

  return (
    <span className="flex items-center gap-1.5">
      <span
        className="w-1.5 h-1.5 rounded-full"
        style={{ background: color, boxShadow: `0 0 4px ${color}` }}
      />
      {label}
    </span>
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
  isVSCode, connectionStatus,
  agentCount, totalTokens,
  showFileAttention, showTranscript, showCostOverlay, showTimeline, isMuted,
  onTogglePanel, onToggleTimeline, onToggleMute,
}: TopBarProps) {
  return (
    <div className="absolute top-3 left-3 right-3 flex items-center gap-4 font-mono text-[10px]" style={{ zIndex: Z.info }}>
      {/* Session tabs — scrollable, takes available space */}
      {sessions.length > 1 && (
        <div className="min-w-0 flex-shrink overflow-x-auto scrollbar-hide">
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
      <div className="flex items-center gap-4 flex-shrink-0" style={{ color: COLORS.textMuted }}>
        {isVSCode && <ConnectionIndicator status={connectionStatus} />}
        <span>{agentCount} agents</span>
        <span>
          {formatTokens(totalTokens)} tokens
          <span style={{ color: COLORS.complete + '65', marginLeft: 4 }}>
            ~${agentCost(totalTokens).toFixed(2)}
          </span>
        </span>

        {/* Mutually exclusive panel group */}
        <div className="flex items-center gap-1 px-1 py-0.5 rounded" style={{
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
        <ToggleButton active={!isMuted} onClick={onToggleMute} style={{ border: `1px solid ${COLORS.toggleBorder}` }}>
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
  isVSCode, connectionStatus,
  agentCount, totalTokens,
  showFileAttention, showTranscript, showCostOverlay, showTimeline, isMuted,
  onTogglePanel, onToggleTimeline, onToggleMute,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useClickOutside(menuRef, () => setMenuOpen(false))

  return (
    <div className="absolute top-2 left-2 right-2 flex items-center gap-2 font-mono text-[10px]" style={{ zIndex: Z.info }}>
      {sessions.length > 1 && (
        <div className="min-w-0 flex-1 overflow-x-auto scrollbar-hide">
          <SessionTabs
            sessions={sessions}
            selectedSessionId={selectedSessionId}
            sessionsWithActivity={sessionsWithActivity}
            onSelectSession={onSelectSession}
            onCloseSession={onCloseSession}
          />
        </div>
      )}
      <div className="flex-1" />

      <div ref={menuRef} className="relative flex-shrink-0" style={{ pointerEvents: 'auto' }}>
        <button
          onClick={() => setMenuOpen(o => !o)}
          className="flex items-center justify-center rounded"
          aria-label="Menu"
          style={{
            width: 32,
            height: 32,
            background: menuOpen ? COLORS.toggleActive : COLORS.toggleInactive,
            border: `1px solid ${COLORS.toggleBorder}`,
            color: menuOpen ? COLORS.holoBright : COLORS.textMuted,
            fontSize: 16,
          }}
        >
          ☰
        </button>

        {menuOpen && (
          <div
            className="absolute right-0 mt-1 rounded flex flex-col gap-1 p-2"
            style={{
              minWidth: 200,
              background: 'rgba(10, 15, 30, 0.92)',
              backdropFilter: 'blur(20px)',
              border: `1px solid ${COLORS.holoBorder06}`,
              boxShadow: '0 4px 20px rgba(0,0,0,0.4)',
            }}
          >
            <div className="flex items-center justify-between px-1 py-1" style={{ color: COLORS.textMuted }}>
              {isVSCode && <ConnectionIndicator status={connectionStatus} />}
              <span>{agentCount} agents</span>
            </div>
            <div className="px-1 pb-1" style={{ color: COLORS.textMuted }}>
              {formatTokens(totalTokens)} tokens
              <span style={{ color: COLORS.complete + '65', marginLeft: 4 }}>
                ~${agentCost(totalTokens).toFixed(2)}
              </span>
            </div>

            <MobileMenuToggle label="Files" active={showFileAttention} onClick={() => { onTogglePanel('files'); setMenuOpen(false) }} />
            <MobileMenuToggle label="Chat" active={showTranscript} onClick={() => { onTogglePanel('transcript'); setMenuOpen(false) }} />
            <MobileMenuToggle
              label="$Cost"
              active={showCostOverlay}
              onClick={() => { onTogglePanel('cost'); setMenuOpen(false) }}
              activeColor={{ bg: COLORS.costActiveBg, text: COLORS.complete }}
            />
            <MobileMenuToggle label="Timeline" active={showTimeline} onClick={() => { onToggleTimeline(); setMenuOpen(false) }} />
            <MobileMenuToggle label={isMuted ? 'Unmute' : 'Mute'} active={!isMuted} onClick={onToggleMute} />
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
      onClick={onClick}
      className="text-left px-2 py-1.5 rounded transition-all"
      style={{
        background: active ? (activeColor?.bg ?? COLORS.toggleActive) : 'transparent',
        color: active ? (activeColor?.text ?? COLORS.holoBright) : COLORS.textMuted,
      }}
    >
      {label}
    </button>
  )
}
