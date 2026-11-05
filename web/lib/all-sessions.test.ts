import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SimulationEvent } from './agent-types'
import { transformEventForAll, mergeEventsByTime, shiftTime, computeAllBase, namespaceName, NAME_FIELDS } from './all-sessions'

const meta = { label: 'Salary-calc', startTime: 10_000 }
const ev = (type: SimulationEvent['type'], payload: Record<string, unknown>, time = 1): SimulationEvent =>
  ({ type, payload, time, sessionId: 's1' })

test('spawn of main uses session label as displayName and namespaces name', () => {
  const out = transformEventForAll(ev('agent_spawn', { name: 'orchestrator', isMain: true }), meta, 10_000)
  assert.equal(out.payload.name, 's1::orchestrator')
  assert.equal(out.payload.displayName, 'Salary-calc')
  assert.equal(out.payload.sessionId, 's1')
})

test('spawn of subagent keeps its own name as displayName and namespaces parent', () => {
  const out = transformEventForAll(ev('agent_spawn', { name: 'explorer', parent: 'orchestrator' }), meta, 10_000)
  assert.equal(out.payload.name, 's1::explorer')
  assert.equal(out.payload.parent, 's1::orchestrator')
  assert.equal(out.payload.displayName, 'explorer')
})

test('every name-bearing field of every event type is namespaced', () => {
  for (const [type, fields] of Object.entries(NAME_FIELDS)) {
    const payload: Record<string, unknown> = {}
    for (const f of fields) payload[f] = 'x'
    const out = transformEventForAll(ev(type as SimulationEvent['type'], payload), meta, 10_000)
    for (const f of fields) assert.equal(out.payload[f], namespaceName('s1', 'x'), `${type}.${f}`)
  }
})

test('dispatch namespaces parent and child; other fields untouched; input not mutated', () => {
  const input = ev('subagent_dispatch', { parent: 'orchestrator', child: 'a', task: 'do it' })
  const out = transformEventForAll(input, meta, 10_000)
  assert.equal(out.payload.child, 's1::a')
  assert.equal(out.payload.task, 'do it')
  assert.equal(input.payload.child, 'a')
})

test('events without a session id pass through; empty names are not namespaced', () => {
  const bare: SimulationEvent = { type: 'agent_idle', payload: { name: 'a' }, time: 3 }
  assert.equal(transformEventForAll(bare, meta, 0), bare)
  assert.equal(transformEventForAll(ev('agent_spawn', { name: 'a', parent: '' }), meta, 10_000).payload.parent, '')
})

test('time shifting onto the common clock', () => {
  assert.equal(shiftTime(5, 12_000, 10_000), 7)
  assert.equal(shiftTime(1, 8_000, 10_000), 0)
  assert.equal(computeAllBase([{ startTime: 30 }, { startTime: 10 }]), 10)
  const out = transformEventForAll(ev('message', { agent: 'a' }, 2), { label: 'L', startTime: 14_000 }, 10_000)
  assert.equal(out.time, 6)
})

test('merge orders by time and keeps per-list order', () => {
  const a = [1, 4, 9].map(t => ({ ...ev('message', { agent: 'a' }, t), sessionId: 'a' }))
  const b = [2, 3, 10].map(t => ({ ...ev('message', { agent: 'b' }, t), sessionId: 'b' }))
  assert.deepEqual(mergeEventsByTime([a, b]).map(e => e.time), [1, 2, 3, 4, 9, 10])
  const skew = [ev('message', {}, 5), ev('message', {}, 2)]
  assert.deepEqual(mergeEventsByTime([skew, [ev('message', {}, 3)]]).map(e => e.time), [3, 5, 2])
  assert.equal(mergeEventsByTime([]).length, 0)
})
