import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextScrubberEvents } from './scrubber-events'
import type { TimelineEvent } from './agent-types'

const evs = (n: number): TimelineEvent[] => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, type: 'message', label: '', timestamp: i }))

test('keeps the fuller list when seeking backward within an epoch', () => {
  let st = nextScrubberEvents({ epoch: 0, events: [] }, evs(10), 5, 0)
  const full = st.events
  st = nextScrubberEvents(st, evs(4), 5, 0)
  assert.equal(st.events, full)
  st = nextScrubberEvents(st, evs(12), 5, 0)
  assert.equal(st.events.length, 12)
})

test('a new epoch drops the previous session markers even when the new list is shorter', () => {
  let st = nextScrubberEvents({ epoch: 0, events: [] }, evs(1500), 100, 0)
  st = nextScrubberEvents(st, evs(300), 100, 1)
  assert.equal(st.events.length, 300)
  assert.equal(st.epoch, 1)
})

test('empty list at ~zero duration clears', () => {
  const st = nextScrubberEvents({ epoch: 0, events: evs(3) }, [], 0, 0)
  assert.equal(st.events.length, 0)
})
