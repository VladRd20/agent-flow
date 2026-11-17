'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { SessionInfo } from '@/lib/vscode-bridge'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { ALL_SESSIONS_ID } from '@/lib/all-sessions'
import { allTabLabel, nextRunningSessionId, sessionCounts } from '@/lib/session-nav'
import { decideFade, decideOverflow, type TabFade } from '@/lib/tab-overflow'

interface SessionTabsProps {
  sessions: SessionInfo[]
  selectedSessionId: string | null
  sessionsWithActivity: Set<string>
  onSelectSession: (id: string) => void
  onCloseSession: (id: string) => void
}

export function SessionTabs({
  sessions,
  selectedSessionId,
  sessionsWithActivity,
  onSelectSession,
  onCloseSession,
}: SessionTabsProps) {
  const isMobile = useIsMobile()
  const scrollerRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<Map<string, HTMLElement>>(new Map())
  const tablistRef = useRef<HTMLDivElement>(null)
  const overflowRef = useRef(false)
  const [overflow, setOverflow] = useState(false)
  const [fade, setFade] = useState<TabFade>('none')

  const setTabRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) tabRefs.current.set(id, el)
    else tabRefs.current.delete(id)
  }, [])

  // Overflow is measured on the tab list alone (w-max, so its width is the tabs' natural width),
  // never on the scroller's scrollWidth: that includes the "Next running" chip, and the chip
  // appearing/disappearing would flip the measurement that decides whether it is shown.
  const updateFade = useCallback(() => {
    const el = scrollerRef.current
    const list = tablistRef.current
    if (!el || !list) return
    overflowRef.current = decideOverflow(overflowRef.current, list.offsetWidth, el.clientWidth)
    setOverflow(prev => (prev === overflowRef.current ? prev : overflowRef.current))
    const next = decideFade(overflowRef.current, el.scrollLeft, el.clientWidth, el.scrollWidth)
    setFade(prev => (prev === next ? prev : next))
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    updateFade()
    el.addEventListener('scroll', updateFade, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateFade) : null
    ro?.observe(el)
    if (tablistRef.current) ro?.observe(tablistRef.current)
    return () => {
      el.removeEventListener('scroll', updateFade)
      ro?.disconnect()
    }
  }, [updateFade, sessions.length])

  // Scroll selected tab into view whenever it changes
  useEffect(() => {
    if (!selectedSessionId) return
    const el = tabRefs.current.get(selectedSessionId)
    el?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
  }, [selectedSessionId])

  // WAI-ARIA tabs: roving tabindex + Arrow/Home/End, automatic activation.
  const tabIds = sessions.length > 0 ? [ALL_SESSIONS_ID, ...sessions.map(x => x.id)] : []
  const focusableId = selectedSessionId && tabIds.includes(selectedSessionId) ? selectedSessionId : tabIds[0]
  const onTabKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    if (target.getAttribute('role') !== 'tab') return
    const cur = tabIds.indexOf(target.dataset.tabId ?? '')
    if (cur < 0) return
    let next = cur
    if (e.key === 'ArrowRight') next = (cur + 1) % tabIds.length
    else if (e.key === 'ArrowLeft') next = (cur - 1 + tabIds.length) % tabIds.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = tabIds.length - 1
    else return
    e.preventDefault()
    const id = tabIds[next]
    onSelectSession(id)
    tabRefs.current.get(id)?.querySelector<HTMLElement>('[role="tab"]')?.focus()
  }

  const { live: liveCount, total: totalCount } = sessionCounts(sessions)
  const nextRunningId = nextRunningSessionId(sessions, selectedSessionId)

  const fadeClass = fade === 'none' ? '' : `af-fade-${fade}`

  return (
    <div
      ref={scrollerRef}
      className={`min-w-0 overflow-x-auto overflow-y-hidden scrollbar-hide snap-x overscroll-x-contain ${fadeClass}`}
      style={{ touchAction: 'pan-x', scrollPaddingInline: isMobile ? 0 : 12 }}
    >
      {/* Row height is reserved whenever the strip overflows (or on mobile), so the chip coming and
          going never changes the height of the top bar */}
      <div
        className={`flex gap-1 w-max items-center ${isMobile ? 'min-h-11' : ''}`}
        style={{ minHeight: !isMobile && overflow ? 32 : undefined }}
      >
      <div ref={tablistRef} role="tablist" aria-label="Sessions" onKeyDown={onTabKeyDown} className={`flex gap-1 w-max ${isMobile ? 'items-center min-h-11' : ''}`}>
        {sessions.length > 0 && (() => {
          const isSelected = selectedSessionId === ALL_SESSIONS_ID
          const anyActive = sessions.some(x => x.status === 'active')
          return (
            <div
              ref={(el) => setTabRef(ALL_SESSIONS_ID, el)}
              className="group snap-start rounded transition-all flex items-center flex-shrink-0"
              style={{
                background: isSelected ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
                border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
                color: isSelected ? COLORS.holoBright : COLORS.textMuted,
                minHeight: isMobile ? 32 : undefined,
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-label={liveCount > 0 ? `All sessions (${liveCount} running of ${totalCount})` : `All sessions (${totalCount})`}
                data-tab-id={ALL_SESSIONS_ID}
                tabIndex={focusableId === ALL_SESSIONS_ID ? 0 : -1}
                onClick={() => onSelectSession(ALL_SESSIONS_ID)}
                className="af-hit pl-1.5 py-0.5 pr-1.5 flex items-center gap-1 min-w-0 self-stretch"
                style={{ whiteSpace: 'nowrap', color: 'inherit' }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                  aria-hidden="true"
                  style={{
                    background: anyActive ? COLORS.complete : 'transparent',
                    border: anyActive ? 'none' : `1px solid ${COLORS.idle}99`,
                    boxSizing: 'border-box',
                    boxShadow: anyActive ? `0 0 4px ${COLORS.complete}` : 'none',
                  }}
                />
                <svg width="9" height="9" viewBox="0 0 10 10" fill="currentColor" aria-hidden="true" className="flex-shrink-0">
                  <rect x="0" y="0" width="4" height="4" rx="0.8" /><rect x="6" y="0" width="4" height="4" rx="0.8" />
                  <rect x="0" y="6" width="4" height="4" rx="0.8" /><rect x="6" y="6" width="4" height="4" rx="0.8" />
                </svg>
                <span className="max-[420px]:hidden">{allTabLabel(liveCount, totalCount)}</span>
                <span className="hidden max-[420px]:inline" aria-hidden="true">
                  {liveCount > 0 ? `All · ${liveCount}/${totalCount}` : `All · ${totalCount}`}
                </span>
              </button>
            </div>
          )
        })()}
        {sessions.map(session => {
          const isSelected = session.id === selectedSessionId
          const isActive = session.status === 'active'
          const hasActivity = sessionsWithActivity.has(session.id)
          // Green dot: session is active, OR has unseen background activity
          const showGreen = isActive || hasActivity
          // Close is hover-revealed on desktop; touch has no hover, so show it on the selected tab
          const closeVisibility = isMobile
            ? (isSelected ? 'opacity-70' : 'hidden')
            // af-tab-close: globals.css shows it wherever hover is unavailable (touch tablets)
            : `af-tab-close ${isSelected ? 'opacity-70' : 'opacity-0 group-hover:opacity-60'} focus-visible:opacity-100`
          return (
            <div
              key={session.id}
              ref={(el) => setTabRef(session.id, el)}
              className={`group snap-start rounded transition-all flex items-center flex-shrink-0 ${isMobile ? 'min-w-28' : ''}`}
              style={{
                background: isSelected ? COLORS.tabSelectedBg : COLORS.tabInactiveBg,
                border: `1px solid ${isSelected ? COLORS.tabSelectedBorder : COLORS.tabInactiveBorder}`,
                color: isSelected ? COLORS.holoBright : COLORS.textMuted,
                minHeight: isMobile ? 32 : undefined,
              }}
            >
              <button
                type="button"
                role="tab"
                aria-selected={isSelected}
                aria-label={`${session.label}, ${isActive ? 'running' : hasActivity ? 'new activity' : 'idle'}`}
                data-tab-id={session.id}
                tabIndex={focusableId === session.id ? 0 : -1}
                onClick={() => onSelectSession(session.id)}
                className="af-hit pl-1.5 py-0.5 pr-1 flex items-center gap-1 min-w-0 self-stretch"
                style={{ whiteSpace: 'nowrap', color: 'inherit' }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                  aria-hidden="true"
                  style={{
                    // Filled dot = running / new activity; hollow ring = idle (not colour alone)
                    background: showGreen ? COLORS.complete : 'transparent',
                    border: showGreen ? 'none' : `1px solid ${COLORS.idle}99`,
                    boxSizing: 'border-box',
                    boxShadow: showGreen ? `0 0 4px ${COLORS.complete}` : 'none',
                    animation: hasActivity && !isSelected ? 'pulse 1.5s infinite' : 'none',
                  }}
                />
                <span className="truncate max-w-28 min-[420px]:max-w-36 md:max-w-64">{session.label}</span>
              </button>
              <button
                type="button"
                aria-label={`Close session ${session.label}`}
                tabIndex={isMobile && !isSelected ? -1 : 0}
                className={`af-hit pr-1.5 pl-0.5 self-stretch transition-opacity ${closeVisibility}`}
                style={{ color: COLORS.tabClose, fontSize: isMobile ? 11 : 8, lineHeight: '10px' }}
                onClick={(e) => {
                  e.stopPropagation()
                  onCloseSession(session.id)
                }}
              >
                ✕
              </button>
            </div>
          )
        })}
      </div>
      {(isMobile || overflow) && nextRunningId && (
        <button
          type="button"
          onClick={() => onSelectSession(nextRunningId)}
          aria-label="Jump to next running session"
          className="af-hit snap-start flex-shrink-0 rounded px-2 py-0.5 flex items-center gap-1"
          style={{
            whiteSpace: 'nowrap',
            minHeight: 32,
            background: COLORS.tabInactiveBg,
            border: `1px solid ${COLORS.tabSelectedBorder}`,
            color: COLORS.complete,
          }}
        >
          <span aria-hidden="true">Next running ▸</span>
        </button>
      )}
      </div>
    </div>
  )
}
