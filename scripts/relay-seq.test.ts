import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { SeqAssigner, parseSince, formatSince, resolveSince, firstIndexAfter, trimEventBuffer } from './relay-seq'

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

test('trimEventBuffer keeps latest structural events per agent and preserves order', () => {
  const buf: Array<{ seq: number; type: string; payload: Record<string, unknown> }> = []
  let seq = 0
  const push = (type: string, payload: Record<string, unknown>) => buf.push({ seq: ++seq, type, payload })
  push('agent_spawn', { name: 'main' })
  push('agent_spawn', { name: 'sub-a' })
  push('model_detected', { agent: 'sub-a', model: 'm' })
  push('context_update', { agent: 'sub-a', tokens: 10 })
  push('context_update', { agent: 'sub-a', tokens: 20 })
  for (let i = 0; i < 100; i++) push('tool_call_start', { agent: 'main', tool_use_id: `u${i}` })
  trimEventBuffer(buf, 20)
  assert.equal(buf.length, 20)
  const names = buf.filter(e => e.type === 'agent_spawn').map(e => e.payload.name)
  assert.deepEqual(names, ['main', 'sub-a'])
  assert.ok(buf.some(e => e.type === 'model_detected'))
  const ctx = buf.filter(e => e.type === 'context_update')
  assert.deepEqual(ctx.map(e => e.payload.tokens), [20])
  for (let i = 1; i < buf.length; i++) assert.ok(buf[i].seq > buf[i - 1].seq)
  // a reconnecting client (since 0) still receives every agent
  assert.equal(firstIndexAfter(buf, 0), 0)
})

test('trimEventBuffer is a no-op within the cap and falls back to oldest-first when structure exceeds it', () => {
  const small = [{ seq: 1, type: 'message' }, { seq: 2, type: 'message' }]
  trimEventBuffer(small, 5)
  assert.equal(small.length, 2)
  const many = Array.from({ length: 10 }, (_, i) => ({ seq: i + 1, type: 'agent_spawn', payload: { name: `a${i}` } }))
  trimEventBuffer(many, 4)
  assert.deepEqual(many.map(e => e.seq), [7, 8, 9, 10])
})
