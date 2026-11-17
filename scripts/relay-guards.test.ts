import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  StaleSessionMemo, shouldWatchSession, STALE_CHECK_TTL_MS, SUBAGENT_LIVENESS_MAX_AGE_MS,
  UnwatchedTracker, dropExpiredUnwatched, UNWATCHED_MAX_EVENTS, UNWATCHED_TTL_MS, WarnLimiter,
} from './relay-guards'
import { SeqAssigner } from './relay-seq'

const ACTIVE_S = 45 * 60
const HOUR = 3600_000

function harness(opts: { watched?: string[]; subMtime?: number } = {}) {
  let now = 1_000_000_000_000
  let walks = 0
  const watched = new Set(opts.watched ?? [])
  const deps = {
    isWatched: (id: string) => watched.has(id),
    newestSubagentMtime: () => { walks++; return opts.subMtime ?? 0 },
    now: () => now,
  }
  return { deps, memo: new StaleSessionMemo(), walks: () => walks, advance: (ms: number) => { now += ms }, now: () => now, watched }
}

// ── Item 1: session scan ────────────────────────────────────────────────────

test('scan: already-watched sessions never walk the subagent tree', () => {
  const h = harness({ watched: ['s1'] })
  assert.equal(shouldWatchSession('s1', h.now() - 2 * HOUR, ACTIVE_S, h.memo, h.deps), false)
  assert.equal(h.walks(), 0)
})

test('scan: recent main file is watched without a walk', () => {
  const h = harness()
  assert.equal(shouldWatchSession('s1', h.now() - 60_000, ACTIVE_S, h.memo, h.deps), true)
  assert.equal(h.walks(), 0)
})

test('scan: main file older than 6h is skipped without a walk', () => {
  const h = harness({ subMtime: 1e15 })
  assert.equal(shouldWatchSession('s1', h.now() - SUBAGENT_LIVENESS_MAX_AGE_MS - 1000, ACTIVE_S, h.memo, h.deps), false)
  assert.equal(h.walks(), 0)
})

test('scan: stale verdict is memoised for 60 s, then re-checked', () => {
  const h = harness({ subMtime: 0 })
  const mtime = h.now() - 2 * HOUR
  assert.equal(shouldWatchSession('s1', mtime, ACTIVE_S, h.memo, h.deps), false)
  assert.equal(h.walks(), 1)
  h.advance(5000)
  assert.equal(shouldWatchSession('s1', mtime, ACTIVE_S, h.memo, h.deps), false)
  assert.equal(h.walks(), 1, 'no second walk inside the TTL')
  h.advance(STALE_CHECK_TTL_MS)
  assert.equal(shouldWatchSession('s1', mtime, ACTIVE_S, h.memo, h.deps), false)
  assert.equal(h.walks(), 2, 're-walked after the TTL')
})

test('scan: a changed main mtime invalidates the memo', () => {
  const h = harness({ subMtime: 0 })
  const mtime = h.now() - 2 * HOUR
  shouldWatchSession('s1', mtime, ACTIVE_S, h.memo, h.deps)
  shouldWatchSession('s1', mtime + 1000, ACTIVE_S, h.memo, h.deps)
  assert.equal(h.walks(), 2)
})

test('scan: live subagent activity under a stale main file starts watching', () => {
  const h = harness()
  const mtime = h.now() - 2 * HOUR
  const live = { ...h.deps, newestSubagentMtime: () => h.now() - 1000 }
  assert.equal(shouldWatchSession('s1', mtime, ACTIVE_S, h.memo, live), true)
})

// ── Item 4: hook-only buffers ───────────────────────────────────────────────

test('unwatched: buffer is capped to the newest events', () => {
  const buf = Array.from({ length: UNWATCHED_MAX_EVENTS + 100 }, (_, i) => i)
  UnwatchedTracker.cap(buf)
  assert.equal(buf.length, UNWATCHED_MAX_EVENTS)
  assert.equal(buf[buf.length - 1], UNWATCHED_MAX_EVENTS + 99)
  assert.equal(buf[0], 100)
})

test('unwatched: expired buffer is dropped but the seq counter keeps counting (never re-issues a lower seq)', () => {
  const t = new UnwatchedTracker()
  const seq = new SeqAssigner()
  const buffers = new Map<string, number[]>()
  const emit = (sid: string) => { const n = seq.next(sid); buffers.set(sid, [...(buffers.get(sid) ?? []), n]); return n }
  t.touch('a', 0)
  assert.equal(emit('a'), 1)
  assert.equal(emit('a'), 2)
  assert.deepEqual(dropExpiredUnwatched(t, buffers, UNWATCHED_TTL_MS - 1, () => false), [])
  assert.deepEqual(dropExpiredUnwatched(t, buffers, UNWATCHED_TTL_MS, () => false), ['a'])
  assert.equal(buffers.has('a'), false)
  assert.equal(t.size, 0)
  assert.equal(emit('a'), 3, 'next event continues above the previous seq')
  assert.equal((seq as unknown as { delete?: unknown }).delete, undefined, 'SeqAssigner has no reset API')
})

test('unwatched: a session that becomes watched is untracked and its buffer is kept', () => {
  const t = new UnwatchedTracker()
  t.touch('new', 0)
  const dropped = t.sweep(UNWATCHED_TTL_MS * 2, id => id === 'new')
  assert.deepEqual(dropped, [])
  assert.equal(t.isTracked('new'), false)
})

// ── Item 6: rate-limited warnings ───────────────────────────────────────────

test('warn limiter: one warning per key per minute', () => {
  const w = new WarnLimiter(60_000)
  assert.equal(w.shouldWarn('s1', 0), true)
  assert.equal(w.shouldWarn('s1', 59_999), false)
  assert.equal(w.shouldWarn('s2', 100), true)
  assert.equal(w.shouldWarn('s1', 60_000), true)
  w.forget('s2')
  assert.equal(w.shouldWarn('s2', 101), true)
})
