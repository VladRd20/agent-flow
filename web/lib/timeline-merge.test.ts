import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTimelineCache, mergeTimelineEvents, newMessages, type TimelineMessage } from './timeline-merge'
import { appendConversation, MAX_CONVERSATION_MESSAGES, type ConversationMessage } from '../hooks/simulation/types'

const msg = (id: number, ts = id): TimelineMessage => ({ id: `m${id}`, type: 'assistant', content: `c${id}`, timestamp: ts })

test('newMessages returns the tail after the last seen id', () => {
  const msgs = [msg(1), msg(2), msg(3)]
  assert.deepEqual(newMessages(msgs, 'm2').map(m => m.id), ['m3'])
  assert.equal(newMessages(msgs, undefined).length, 3)
  assert.equal(newMessages(msgs, 'gone').length, 3)
  assert.equal(newMessages(msgs, 'm3').length, 0)
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
