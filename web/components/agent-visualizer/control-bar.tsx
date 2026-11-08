'use client'

import { useState, useEffect, useCallback, useRef, memo } from 'react'
import { TimelineEvent, Z, POPUP, TIMING } from '@/lib/agent-types'
import { COLORS } from '@/lib/colors'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { setBottomInset } from '@/lib/layout-insets'

interface ControlBarProps {
  isPlaying: boolean
  speed: number
  currentTime: number
  totalDuration: number
  onPlayPause: () => void
  onRestart: () => void
  onSpeedChange: (speed: number) => void
  onSeek?: (time: number) => void
  timelineEvents: TimelineEvent[]
  isReviewing?: boolean
  eventCount?: number
  onResumeLive?: () => void
  onEnterReview?: () => void
  /** Hide while a mobile sheet is open (keeps state, drops out of layout/hit-testing) */
  hidden?: boolean
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function getEventColor(type: TimelineEvent['type']): string {
  switch (type) {
    case 'thinking': return COLORS.thinking
    case 'tool_call': return COLORS.tool
    case 'tool_result': return COLORS.return
    case 'message': return COLORS.message
    case 'error': return COLORS.error
    default: return COLORS.idle
  }
}

/** Max event marker dots rendered on the scrubber (prevents DOM bloat) */
const MAX_SCRUBBER_DOTS = 120

/** Shared event marker dots on the scrubber track.
 *  Memoized to avoid re-rendering every frame when only currentTime changes in the parent. */
const EventMarkers = memo(function EventMarkers({ events, totalDuration, className = '' }: {
  events: TimelineEvent[]
  totalDuration: number
  className?: string
  /** Pass events.length to bust memo when array is mutated in place */
  eventCount?: number
}) {
  // Down-sample to MAX_SCRUBBER_DOTS evenly spaced events when list is large
  const visible = events.length > MAX_SCRUBBER_DOTS
    ? Array.from({ length: MAX_SCRUBBER_DOTS }, (_, i) => events[Math.floor(i * events.length / MAX_SCRUBBER_DOTS)])
    : events
  // Position dots relative to the last event so they always span the full bar,
  // rather than compressing into a fraction when currentTime runs ahead of events
  const lastEventTime = events.length > 0 ? events[events.length - 1].timestamp : 0
  const effectiveDuration = lastEventTime > 0 ? lastEventTime : totalDuration
  return (
    <>
      {visible.map((event) => {
        const pos = effectiveDuration > 0 ? (event.timestamp / effectiveDuration) * 100 : 0
        if (pos < 0 || pos > 100) return null
        return (
          <div
            key={event.id}
            className={`absolute top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full ${className}`}
            style={{ left: `${pos}%`, background: getEventColor(event.type) }}
          />
        )
      })}
    </>
  )
})

/** Hook to cache the full set of timeline events (dots don't disappear when seeking backward) */
function useScrubberEvents(timelineEvents: TimelineEvent[], totalDuration: number) {
  const fullEventsRef = useRef<TimelineEvent[]>([])
  if (timelineEvents.length === 0 && totalDuration < 0.1) {
    fullEventsRef.current = []
  } else if (timelineEvents.length >= fullEventsRef.current.length) {
    fullEventsRef.current = timelineEvents
  }
  return fullEventsRef.current
}

/**
 * Publishes the bar's measured height as --af-bottom-bar-h (so floating panels sit above it)
 * and, on mobile only, as the camera's bottom inset (so fit-to-view leaves room for it).
 * Zero-height measurements (hidden bar) are ignored so layout does not jump while a sheet is open.
 */
function useBarMetrics(ref: React.RefObject<HTMLElement | null>, isMobile: boolean) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const publish = () => {
      const h = el.getBoundingClientRect().height
      if (h <= 0) return
      document.documentElement.style.setProperty('--af-bottom-bar-h', `${Math.round(h)}px`)
      // The bar floats over the canvas at every size, so fit-to-view always leaves room for it
      const bottom = parseFloat(getComputedStyle(el).bottom) || 0
      setBottomInset(h + bottom + 8)
    }
    publish()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(publish) : null
    ro?.observe(el)
    window.addEventListener('resize', publish)
    return () => {
      ro?.disconnect()
      window.removeEventListener('resize', publish)
      setBottomInset(0)
    }
  }, [ref, isMobile])
}

const barWrapperStyle = (hidden: boolean | undefined): React.CSSProperties => ({
  pointerEvents: hidden ? 'none' : 'auto',
  display: hidden ? 'none' : undefined,
  maxWidth: POPUP.controlBarMaxWidth,
  zIndex: Z.controlBar,
  bottom: 'var(--af-bottom)',
  left: 'var(--af-edge-left)',
  right: 'var(--af-edge-right)',
})

export function ControlBar(props: ControlBarProps) {
  const { isReviewing = false } = props
  return isReviewing ? <ReviewControlBar {...props} /> : <LiveControlBar {...props} />
}

// ─── Live Mode Control Bar ───────────────────────────────────────────────────

function LiveControlBar({
  currentTime, totalDuration, timelineEvents,
  eventCount = 0, onEnterReview, isReviewing, hidden,
}: ControlBarProps) {
  const [pulseOn, setPulseOn] = useState(true)
  const scrubberEvents = useScrubberEvents(timelineEvents, totalDuration)
  const isMobile = useIsMobile()
  const barRef = useRef<HTMLDivElement>(null)
  useBarMetrics(barRef, isMobile)

  useEffect(() => {
    if (isReviewing) return
    const interval = setInterval(() => setPulseOn(p => !p), TIMING.livePulseMs)
    return () => clearInterval(interval)
  }, [isReviewing])

  return (
    <div
      ref={barRef}
      className="absolute mx-auto"
      style={barWrapperStyle(hidden)}
    >
      <div className={`glass-card flex items-center gap-3 ${isMobile ? 'px-3 py-2' : 'px-5 py-3'}`}>
        {/* LIVE badge */}
        <div className="flex items-center gap-1.5 shrink-0">
          <span
            className="w-2 h-2 rounded-full transition-opacity duration-500"
            style={{
              background: COLORS.liveDot,
              boxShadow: pulseOn ? `0 0 8px ${COLORS.liveDot}, 0 0 16px rgba(255,68,68,0.3)` : `0 0 4px ${COLORS.liveDot}80`,
              opacity: pulseOn ? 1 : 0.6,
            }}
          />
          <span className="text-[10px] font-mono font-semibold tracking-wider" style={{ color: COLORS.liveText }}>
            LIVE
          </span>
        </div>

        {/* Time */}
        <span className="text-xs font-mono shrink-0" style={{ color: COLORS.textPrimary }}>
          {formatTime(currentTime)}
        </span>

        {/* Read-only event track */}
        <div className="flex-1 relative h-6 flex items-center">
          <div
            className="w-full rounded-full relative"
            style={{ height: 3, background: COLORS.holoBg10 }}
          >
            <EventMarkers events={scrubberEvents} totalDuration={totalDuration} eventCount={scrubberEvents.length} className="opacity-80" />
          </div>
        </div>

        {/* Event count */}
        <span className="text-[10px] font-mono shrink-0" style={{ color: COLORS.textMuted }}>
          {eventCount}
        </span>

        {/* Review button */}
        <button
          type="button"
          aria-label="Enter review mode"
          onClick={onEnterReview}
          className={`af-hit px-2.5 py-1 rounded text-[10px] font-mono transition-all hover:scale-105 ${isMobile ? 'min-h-11' : ''}`}
          style={{
            background: COLORS.holoBg10,
            border: `1px solid ${COLORS.reviewBtnBorder}`,
            color: COLORS.textPrimary,
          }}
        >
          ⏸ Review
        </button>
      </div>
    </div>
  )
}

// ─── Review Mode Control Bar ─────────────────────────────────────────────────

const SPEEDS = [0.5, 1, 2, 4] as const

function ReviewControlBar({
  isPlaying, speed, currentTime, totalDuration,
  onPlayPause, onRestart, onSpeedChange, onSeek,
  timelineEvents, isReviewing, onResumeLive, hidden,
}: ControlBarProps) {
  const barRef = useRef<HTMLDivElement>(null)
  const scrubberRef = useRef<HTMLDivElement>(null)
  const [isScrubbing, setIsScrubbing] = useState(false)
  const scrubberEvents = useScrubberEvents(timelineEvents, totalDuration)
  const progress = totalDuration > 0 ? currentTime / totalDuration : 0
  const isMobile = useIsMobile()
  useBarMetrics(barRef, isMobile)
  const cycleSpeed = () => {
    const i = SPEEDS.findIndex(s => s === speed)
    onSpeedChange(SPEEDS[(i + 1) % SPEEDS.length])
  }

  const scrubToClientX = useCallback((clientX: number) => {
    const rect = scrubberRef.current?.getBoundingClientRect()
    if (!rect || !onSeek) return
    const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
    onSeek(ratio * totalDuration)
  }, [onSeek, totalDuration])

  useEffect(() => {
    if (!isScrubbing) return
    const handleMove = (e: MouseEvent) => scrubToClientX(e.clientX)
    const handleUp = () => setIsScrubbing(false)
    window.addEventListener('mousemove', handleMove)
    window.addEventListener('mouseup', handleUp)
    return () => {
      window.removeEventListener('mousemove', handleMove)
      window.removeEventListener('mouseup', handleUp)
    }
  }, [isScrubbing, scrubToClientX])

  // Touch scrubbing — separate from the mouse path above (native listeners,
  // passive:false, so preventDefault suppresses synthesized mouse events and
  // page scroll without altering the mouse handlers at all).
  useEffect(() => {
    const el = scrubberRef.current
    if (!el) return
    const onTouchStart = (e: TouchEvent) => {
      e.preventDefault()
      setIsScrubbing(true)
      const t = e.touches[0]
      if (t) scrubToClientX(t.clientX)
    }
    el.addEventListener('touchstart', onTouchStart, { passive: false })
    return () => el.removeEventListener('touchstart', onTouchStart)
  }, [scrubToClientX, isMobile])

  useEffect(() => {
    if (!isScrubbing) return
    const handleTouchMove = (e: TouchEvent) => {
      e.preventDefault()
      const t = e.touches[0]
      if (t) scrubToClientX(t.clientX)
    }
    const handleTouchEnd = () => setIsScrubbing(false)
    window.addEventListener('touchmove', handleTouchMove, { passive: false })
    window.addEventListener('touchend', handleTouchEnd)
    window.addEventListener('touchcancel', handleTouchEnd)
    return () => {
      window.removeEventListener('touchmove', handleTouchMove)
      window.removeEventListener('touchend', handleTouchEnd)
      window.removeEventListener('touchcancel', handleTouchEnd)
    }
  }, [isScrubbing, scrubToClientX])

  const scrubber = (
    <div
      ref={scrubberRef}
      className={`flex-1 min-w-0 ${isMobile ? 'h-9' : 'h-8'} relative flex items-center group cursor-pointer`}
      style={{ touchAction: 'none' }}
      role="slider"
      tabIndex={0}
      aria-label="Timeline position"
      aria-valuemin={0}
      aria-valuemax={Math.round(totalDuration * 1000) / 1000}
      aria-valuenow={Math.round(currentTime * 1000) / 1000}
      aria-valuetext={`${formatTime(currentTime)} of ${formatTime(totalDuration)}`}
      onKeyDown={(e) => {
        if (!onSeek || e.ctrlKey || e.metaKey || e.altKey) return
        const step = Math.max(totalDuration / 50, 0.1)
        let next: number | null = null
        if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = currentTime + step
        else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = currentTime - step
        else if (e.key === 'Home') next = 0
        else if (e.key === 'End') next = totalDuration
        if (next === null) return
        e.preventDefault()
        onSeek(Math.max(0, Math.min(totalDuration, next)))
      }}
      onMouseDown={(e) => {
        e.preventDefault()
        setIsScrubbing(true)
        scrubToClientX(e.clientX)
      }}
    >
      <div
        className="w-full rounded-full relative transition-all duration-150 group-hover:h-2"
        style={{ height: isScrubbing ? 8 : 4, background: COLORS.glassBorder }}
      >
        {/* Progress fill */}
        <div
          className="h-full rounded-full transition-[width]"
          style={{
            width: `${progress * 100}%`,
            background: COLORS.scrubberFill,
          }}
        />
        <EventMarkers
          events={scrubberEvents}
          totalDuration={totalDuration}
          eventCount={scrubberEvents.length}
          className="opacity-60 group-hover:opacity-100 transition-opacity"
        />
      </div>

      {/* Playhead */}
      <div
        className="absolute top-1/2 -translate-y-1/2 rounded-full transition-all duration-150 group-hover:w-4 group-hover:h-4"
        style={{
          left: `${progress * 100}%`,
          width: isScrubbing ? 16 : 12,
          height: isScrubbing ? 16 : 12,
          marginLeft: isScrubbing ? -8 : -6,
          background: COLORS.textPrimary,
          boxShadow: COLORS.scrubberHeadGlow,
        }}
      />
    </div>
  )

  const playButton = (
    <button
      type="button"
      aria-label={isPlaying ? 'Pause' : 'Play'}
      onClick={onPlayPause}
      className={`af-hit ${isMobile ? 'w-11 h-11' : 'w-9 h-9'} rounded-full flex items-center justify-center transition-all shrink-0 hover:scale-110`}
      style={{
        background: isPlaying ? COLORS.playBtnActiveBg : COLORS.playBtnBg,
        border: `1.5px solid ${COLORS.playBtnBorder}`,
        boxShadow: COLORS.playBtnGlow,
      }}
    >
      <span style={{ color: COLORS.textPrimary, fontSize: 14, marginLeft: isPlaying ? 0 : 2 }}>
        {isPlaying ? '⏸' : '▶'}
      </span>
    </button>
  )

  const timeLabel = (
    <span className="text-xs font-mono shrink-0" style={{ color: COLORS.textPrimary, minWidth: 42 }}>
      {formatTime(currentTime)}
    </span>
  )

  const durationLabel = (
    <span className="text-[10px] font-mono shrink-0" style={{ color: COLORS.textMuted }}>
      {formatTime(totalDuration)}
    </span>
  )

  const speedControls = isMobile ? (
    <button
      type="button"
      aria-label={`Playback speed ${speed}x, tap to change`}
      onClick={cycleSpeed}
      className="af-hit px-2.5 py-1 rounded text-[10px] font-mono transition-all shrink-0 min-h-11"
      style={{ background: COLORS.playBtnActiveBg, color: COLORS.textPrimary, minWidth: 44 }}
    >
      {speed}x
    </button>
  ) : (
    <div className="flex items-center gap-0.5 shrink-0" role="group" aria-label="Playback speed">
      {SPEEDS.map((s) => (
        <button
          key={s}
          type="button"
          aria-label={`Speed ${s}x`}
          aria-pressed={speed === s}
          onClick={() => onSpeedChange(s)}
          className="af-hit px-2 py-0.5 rounded text-[10px] font-mono transition-all"
          style={{
            background: speed === s ? COLORS.playBtnActiveBg : 'transparent',
            color: speed === s ? COLORS.textPrimary : COLORS.textMuted,
          }}
        >
          {s}x
        </button>
      ))}
    </div>
  )

  const resumeButton = isReviewing && (
    <button
      type="button"
      aria-label="Resume live"
      onClick={onResumeLive}
      className={`af-hit px-2.5 py-1 rounded text-[10px] font-mono font-semibold transition-all hover:scale-105 shrink-0 ${isMobile ? 'min-h-11' : ''}`}
      style={{
        background: COLORS.liveResumeBg,
        border: `1px solid ${COLORS.liveResumeBorder}`,
        color: COLORS.liveText,
      }}
    >
      ▶ LIVE
    </button>
  )

  const restartButton = isReviewing && (
    <button
      type="button"
      aria-label="Restart"
      onClick={onRestart}
      className={`af-hit text-sm px-1 transition-all shrink-0 hover:scale-110 ${isMobile ? 'min-w-11 min-h-11' : ''}`}
      style={{ color: COLORS.textDim }}
    >
      ⟲
    </button>
  )

  return (
    <div
      ref={barRef}
      className="absolute mx-auto"
      style={barWrapperStyle(hidden)}
    >
      {isMobile ? (
        // Two rows on phones: full-width scrubber on top, transport controls below
        <div className="glass-card flex flex-col gap-1 px-3 py-2">
          <div className="flex items-center gap-2">
            {timeLabel}
            {scrubber}
            {durationLabel}
          </div>
          <div className="flex items-center gap-3">
            {playButton}
            {speedControls}
            <div className="flex-1" />
            {resumeButton}
            {restartButton}
          </div>
        </div>
      ) : (
        <div className="glass-card flex items-center gap-3 px-5 py-3">
          {playButton}
          {timeLabel}
          {scrubber}
          {durationLabel}
          {speedControls}
          {resumeButton}
          {restartButton}
        </div>
      )}
    </div>
  )
}
