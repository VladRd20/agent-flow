import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SeqAssigner, parseSince, formatSince, resolveSince, firstIndexAfter } from './relay-seq'

test('SeqAssigner is monotonic and independent per session', () => {
  const s = new SeqAssigner()
  assert.deepEqual([s.next('a'), s.next('a'), s.next('b'), s.next('a')], [1, 2, 1, 3])
  assert.equal(s.current('a'), 3)
  assert.equal(s.current('zzz'), 0)
})

test('parseSince round-trips and tolerates junk / colons in ids', () => {
  const m = new Map([['abc', 5], ['codex:thread:1', 12]])
  assert.deepEqual(parseSince(formatSince(m)), m)
  assert.deepEqual([...parseSince('bad,:3,x:NaN,y:-1,ok:7')], [['ok', 7]])
  assert.equal(parseSince(undefined).size, 0)
})

test('resolveSince ignores the cursor when the epoch differs (server restarted)', () => {
  const q = new URLSearchParams({ epoch: 'old', since: 'a:10' })
  assert.equal(resolveSince(q, 'new').size, 0)
  assert.deepEqual([...resolveSince(q, 'old')], [['a', 10]])
  assert.equal(resolveSince(new URLSearchParams({ since: 'a:10' }), 'new').size, 0)
})

test('firstIndexAfter selects only newer events', () => {
  const buf = [1, 2, 3, 4, 5].map(seq => ({ seq }))
  assert.equal(firstIndexAfter(buf, 0), 0)
  assert.equal(firstIndexAfter(buf, 3), 3)
  assert.equal(firstIndexAfter(buf, 5), 5)
  assert.equal(firstIndexAfter(buf, 99), 5)
  assert.equal(firstIndexAfter([], 3), 0)
  // buffer front-trimmed: cursor older than the oldest kept event => everything
  assert.equal(firstIndexAfter([{ seq: 40 }, { seq: 41 }], 10), 0)
})
