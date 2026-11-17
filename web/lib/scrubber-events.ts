import type { TimelineEvent } from '@/lib/agent-types'

export interface ScrubberEventsState {
  epoch: number
  events: TimelineEvent[]
}

/**
 * The scrubber keeps showing the fullest list seen within one timeline epoch, so markers do not
 * disappear when seeking backward (the replayed conversations are shorter). A new epoch
 * (session switch / restart / snapshot restore) starts from scratch.
 */
export function nextScrubberEvents(
  prev: ScrubberEventsState,
  incoming: TimelineEvent[],
  totalDuration: number,
  epoch: number,
): ScrubberEventsState {
  if (epoch !== prev.epoch) return { epoch, events: incoming }
  if (incoming.length === 0 && totalDuration < 0.1) return { epoch, events: [] }
  if (incoming.length >= prev.events.length) return { epoch, events: incoming }
  return prev
}
