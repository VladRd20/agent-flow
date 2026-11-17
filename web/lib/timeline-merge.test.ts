import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTimelineCache, mergeTimelineEvents, messageKeys, type TimelineMessage } from './timeline-merge'
import { appendConversation, MAX_CONVERSATION_MESSAGES, type ConversationMessage } from '../hooks/simulation/types'

const msg = (id: number, ts = id): TimelineMessage => ({ id: `m${id}`, type: 'assistant', content: `c${id}`, timestamp: ts })

test('messageKeys numbers messages sharing a timestamp and ignores ids', () => {
  assert.deepEqual(messageKeys('a', [msg(1, 5), msg(2, 5), msg(3, 6)]), ['a|5|0', 'a|5|1', 'a|6|0'])
})

test('keeps appending after the per-agent conversation cap is reached', () => {
  const cache = createTimelineCache(100000)
  const conv = new Map<string, ConversationMessage[]>()
  const total = MAX_CONVERSATION_MESSAGES + 50
  for (let i = 0; i < total; i++) {
    appendConversation(conv, 'a', { type: 'assistant', content: `c${i}`, timestamp: i })
    mergeTimelineEvents(cache, conv)
  }
  assert.equal(conv.get('a')!.length, MAX_CONVERSATION_MESSAGES)
  assert.equal(cache.events.length, total)
  assert.equal(cache.events[cache.events.length - 1].timestamp, total - 1)
})

test('batch larger than the cap in one call keeps the newest events', () => {
  const cache = createTimelineCache(10)
  const conv = new Map<string, TimelineMessage[]>([['a', Array.from({ length: 30 }, (_, i) => msg(i))]])
  assert.equal(mergeTimelineEvents(cache, conv), true)
  assert.equal(cache.events.length, 10)
  assert.equal(cache.events[9].timestamp, 29)
  assert.equal(mergeTimelineEvents(cache, conv), false)
})

test('cap trims oldest events and order is kept across agents', () => {
  const cache = createTimelineCache(5)
  const conv = new Map<string, TimelineMessage[]>([
    ['a', [msg(1, 10), msg(2, 30), msg(3, 50)]],
    ['b', [{ ...msg(4, 20), id: 'b1' }, { ...msg(5, 40), id: 'b2' }, { ...msg(6, 60), id: 'b3' }]],
  ])
  mergeTimelineEvents(cache, conv)
  assert.deepEqual(cache.events.map(e => e.timestamp), [20, 30, 40, 50, 60])
})

test('a fresh cache folds a restarted session from its first message', () => {
  const conv = new Map<string, TimelineMessage[]>([['a', [msg(1), msg(2)]]])
  const old = createTimelineCache()
  mergeTimelineEvents(old, conv)
  const fresh = createTimelineCache()
  assert.equal(mergeTimelineEvents(fresh, conv), true)
  assert.equal(fresh.events.length, 2)
})

// Simulates seekToTime: the log is replayed, so conversations are rebuilt with brand-new ids
// and (when seeking backward) only the messages up to the target time.
const replay = (all: TimelineMessage[], upTo: number, idBase: number): TimelineMessage[] =>
  all.filter(m => m.timestamp <= upTo).map((m, i) => ({ ...m, id: `r${idBase}-${i}` }))
const sameTimes = [1, 2, 2, 3, 4, 5, 5, 5, 6, 7]
const full = sameTimes.map((t, i) => msg(i, t))

test('seek backward then forward leaves the same event set (no duplicates, nothing lost)', () => {
  const cache = createTimelineCache()
  mergeTimelineEvents(cache, new Map([['a', full]]))
  const before = cache.events.map(e => `${e.nodeId}|${e.timestamp}`)
  mergeTimelineEvents(cache, new Map([['a', replay(full, 3, 1)]]))
  assert.equal(cache.events.length, full.length)
  mergeTimelineEvents(cache, new Map([['a', replay(full, 7, 2)]]))
  assert.deepEqual(cache.events.map(e => `${e.nodeId}|${e.timestamp}`), before)
})

test('Resume live (seek to the end) does not change the event count', () => {
  const cache = createTimelineCache(50)
  const conv = new Map([['a', full], ['b', full.map((m, i) => ({ ...m, id: `b${i}` }))]])
  mergeTimelineEvents(cache, conv)
  const n = cache.events.length
  for (let k = 0; k < 5; k++) {
    mergeTimelineEvents(cache, new Map([['a', replay(full, 7, 10 + k)], ['b', replay(full, 7, 20 + k)]]))
  }
  assert.equal(cache.events.length, n)
})
