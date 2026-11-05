'use client'

import { useEffect, useRef, useCallback, useState } from 'react'
import { COLORS } from '@/lib/colors'
import type { SessionInfo } from '@/lib/vscode-bridge'
import { useIsMobile } from '@/hooks/use-is-mobile'

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
  const [fade, setFade] = useState<'none' | 'end' | 'start' | 'both'>('none')

  const setTabRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) tabRefs.current.set(id, el)
    else tabRefs.current.delete(id)
  }, [])

  // Edge fade only while content actually overflows in that direction
  const updateFade = useCallback(() => {
    const el = scrollerRef.current
    if (!el) return
    const overflowing = el.scrollWidth - el.clientWidth > 2
    const atStart = el.scrollLeft <= 2
    const atEnd = el.scrollLeft + el.clientWidth >= el.scrollWidth - 2
    const next = !overflowing ? 'none' : atStart ? 'end' : atEnd ? 'start' : 'both'
    setFade(prev => (prev === next ? prev : next))
  }, [])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    updateFade()
    el.addEventListener('scroll', updateFade, { passive: true })
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(updateFade) : null
    ro?.observe(el)
    if (el.firstElementChild) ro?.observe(el.firstElementChild)
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

  const fadeClass = fade === 'none' ? '' : `af-fade-${fade}`

  return (
    <div
      ref={scrollerRef}
      className={`min-w-0 overflow-x-auto overflow-y-hidden scrollbar-hide snap-x overscroll-x-contain ${fadeClass}`}
      style={{ touchAction: 'pan-x', scrollPaddingInline: 12 }}
    >
      <div role="tablist" aria-label="Sessions" className={`flex gap-1 w-max ${isMobile ? 'items-center min-h-11' : ''}`}>
        {sessions.map(session => {
          const isSelected = session.id === selectedSessionId
          const isActive = session.status === 'active'
          const hasActivity = sessionsWithActivity.has(session.id)
          // Green dot: session is active, OR has unseen background activity
          const showGreen = isActive || hasActivity
          // Close is hover-revealed on desktop; touch has no hover, so show it on the selected tab
          const closeVisibility = isMobile
            ? (isSelected ? 'opacity-70' : 'hidden')
            : 'opacity-0 group-hover:opacity-60 focus-visible:opacity-100'
          return (
            <div
              key={session.id}
              ref={(el) => setTabRef(session.id, el)}
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
                onClick={() => onSelectSession(session.id)}
                className="af-hit pl-1.5 py-0.5 pr-1 flex items-center gap-1 min-w-0 self-stretch"
                style={{ whiteSpace: 'nowrap', color: 'inherit' }}
              >
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{
                    background: showGreen ? COLORS.complete : COLORS.idle + '40',
                    boxShadow: showGreen ? `0 0 4px ${COLORS.complete}` : 'none',
                    animation: hasActivity && !isSelected ? 'pulse 1.5s infinite' : 'none',
                  }}
                />
                <span className="truncate max-w-36 md:max-w-64">{session.label}</span>
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
    </div>
  )
}
