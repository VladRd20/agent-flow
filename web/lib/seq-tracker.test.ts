import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SeqTracker } from './seq-tracker'
import { SessionEventBuffer } from './session-event-buffer'

test('SeqTracker drops duplicates and replays, accepts unsequenced events', () => {
  const t = new SeqTracker()
  assert.equal(t.accept('a', 1), true)
  assert.equal(t.accept('a', 2), true)
  assert.equal(t.accept('a', 2), false)
  assert.equal(t.accept('a', 1), false)
  assert.equal(t.accept('b', 1), true, 'sessions are independent')
  assert.equal(t.accept('a', undefined), true, 'VS Code path has no seq')
  assert.equal(t.accept(undefined, 5), true)
})

test('SeqTracker builds the resume query only once it has an epoch and cursors', () => {
  const t = new SeqTracker()
  assert.equal(t.query(), '')
  t.setEpoch('E1')
  assert.equal(t.query(), '')
  t.accept('a', 3); t.accept('b', 9)
  const q = new URLSearchParams(t.query())
  assert.equal(q.get('epoch'), 'E1')
  assert.equal(q.get('since'), 'a:3,b:9')
})

test('SeqTracker epoch change (server restart) clears cursors and signals reset; first epoch does not', () => {
  const t = new SeqTracker()
  assert.equal(t.setEpoch('E1'), false)
  t.accept('a', 50)
  assert.equal(t.setEpoch('E1'), false, 'same epoch after reconnect keeps cursors')
  assert.equal(t.accept('a', 50), false)
  assert.equal(t.setEpoch('E2'), true)
  assert.equal(t.accept('a', 1), true, 'seq restarted at 1 on the new server is accepted')
})

test('SessionEventBuffer keeps absolute cursors valid across front trimming', () => {
  const b = new SessionEventBuffer<number>(10, 5)
  for (let i = 0; i < 12; i++) b.push(i)
  const bookmark = b.end // 12
  for (let i = 12; i < 18; i++) b.push(i)
  assert.equal(b.end, 18)
  assert.ok(b.base > 0, 'front was trimmed')
  assert.deepEqual(b.sliceFrom(bookmark), [12, 13, 14, 15, 16, 17])
  for (let i = 18; i < 40; i++) b.push(i)
  assert.ok(b.events.length <= 15)
  // a bookmark older than what is retained is clamped, never negative-indexed
  assert.equal(b.sliceFrom(0)[0], b.base)
})
