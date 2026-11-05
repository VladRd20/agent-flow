import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, foldEvents, type ProcessEventContext } from './process-event'
import { createEmptyState, type SimulationState } from './types'
import type { SimulationEvent } from '../../lib/agent-types'

function makeCtx(): ProcessEventContext {
  return {
    syncForceSimulation: () => {},
    findToolSlot: () => ({ x: 10, y: 20 }),
    getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 },
    skipForceSync: true,
  }
}

function synthetic(n: number, startT = 0): SimulationEvent[] {
  const ev: SimulationEvent[] = [
    { time: startT, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true, task: 't' } },
    { time: startT + 1, type: 'agent_spawn', payload: { name: 'child', parent: 'orchestrator', task: 'c' } },
  ]
  for (let i = 0; i < n; i++) {
    const t = startT + 2 + i * 0.5
    ev.push({ time: t, type: 'tool_call_start', payload: { agent: i % 2 ? 'child' : 'orchestrator', tool: 'Read', args: `f${i}.ts`, inputData: { file_path: `f${i}.ts` }, tool_use_id: `u${i}` } })
    ev.push({ time: t + 0.2, type: 'tool_call_end', payload: { agent: i % 2 ? 'child' : 'orchestrator', tool: 'Read', result: 'ok', tokenCost: 10, tool_use_id: `u${i}` } })
    ev.push({ time: t + 0.3, type: 'message', payload: { agent: 'orchestrator', role: i % 3 ? 'assistant' : 'user', content: `m${i}` } })
  }
  ev.push({ time: startT + 3 + n * 0.5, type: 'subagent_return', payload: { parent: 'orchestrator', child: 'child', summary: 's' } })
  ev.push({ time: startT + 4 + n * 0.5, type: 'agent_complete', payload: { name: 'child' } })
  return ev
}

function sequential(events: SimulationEvent[], ctx: ProcessEventContext): SimulationState {
  let st = createEmptyState()
  for (const e of events) st = processEvent(e, { ...st, currentTime: e.time }, ctx)
  return { ...st, currentTime: events[events.length - 1].time }
}

/** Normalise auto-generated conversation ids (global counter differs between runs). */
function norm(st: SimulationState, bubbleCutoff = -Infinity) {
  const conv: Record<string, unknown> = {}
  for (const [k, v] of st.conversations) conv[k] = v.map(({ id: _id, ...rest }) => rest)
  return {
    agents: [...st.agents.entries()].map(([k, a]) => [k, { ...a, messageBubbles: a.messageBubbles.filter(b => b.time >= bubbleCutoff) }]),
    parentEdges: st.edges.filter(e => e.type === 'parent-child'),
    conversations: conv,
    timeline: [...st.timelineEntries.entries()],
    fileAttention: [...st.fileAttention.entries()],
    currentTime: st.currentTime,
  }
}

test('foldEvents without a cutoff equals sequential processEvent for the full state', () => {
  const events = synthetic(40)
  const a = sequential(events, makeCtx())
  const { state: b } = foldEvents(events, createEmptyState(), makeCtx(), { resolveTime: e => e.time })
  assert.deepEqual(norm(b), norm(a))
  assert.equal(b.toolCalls.size, a.toolCalls.size)
  assert.equal(b.particles.length, a.particles.length)
  assert.equal(b.edges.length, a.edges.length)
})

test('historical fold keeps agents/edges/conversations/timeline identical but skips expired visuals', () => {
  const events = synthetic(400)
  const end = events[events.length - 1].time
  const a = sequential(events, makeCtx())
  const { state: b, applied } = foldEvents(events, createEmptyState(), makeCtx(), { resolveTime: e => e.time, visualCutoff: end - 15 })
  const nb = norm(b, end - 15), na = norm(a, end - 15)
  for (const k of Object.keys(na) as Array<keyof typeof na>) assert.deepEqual(nb[k], na[k], `mismatch in ${k}`)
  assert.equal(applied.length, events.length)
  assert.ok(b.toolCalls.size < a.toolCalls.size, 'old tool cards skipped')
  assert.ok(b.particles.length < a.particles.length)
  // recent cards (within lifetime) are still created
  assert.ok(b.toolCalls.size > 0)
  const child = b.agents.get('child')!
  assert.equal(child.toolCalls, a.agents.get('child')!.toolCalls, 'tool counters unaffected by skipped visuals')
})

test('chunked folding equals one big fold', () => {
  const events = synthetic(100)
  const whole = foldEvents(events, createEmptyState(), makeCtx(), { resolveTime: e => e.time }).state
  let st = createEmptyState()
  const ctx = makeCtx()
  for (let i = 0; i < events.length; i += 7) {
    st = foldEvents(events.slice(i, i + 7), st, ctx, { resolveTime: e => e.time }).state
  }
  assert.deepEqual(norm(st), norm(whole))
})

test('a shared skippedTools map lets tool_end in a later slice find its skipped start', () => {
  const events = synthetic(1)
  // split between the tool start and its end
  const startIdx = events.findIndex(e => e.type === 'tool_call_start')
  const first = events.slice(0, startIdx + 1)
  const second = events.slice(startIdx + 1)
  const cutoff = events[events.length - 1].time + 100 // everything is "expired"
  const shared = new Map()
  let st = createEmptyState()
  const ctx = makeCtx()
  st = foldEvents(first, st, ctx, { resolveTime: e => e.time, visualCutoff: cutoff, skippedTools: shared }).state
  st = foldEvents(second, st, ctx, { resolveTime: e => e.time, visualCutoff: cutoff, skippedTools: shared }).state
  const ref = sequential(events, makeCtx())
  assert.deepEqual(norm(st, cutoff).fileAttention, norm(ref, cutoff).fileAttention)
  assert.equal(shared.size, 0, 'consumed by the matching tool_end')
})
