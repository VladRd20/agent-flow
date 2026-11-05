import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { foldEvents, type ProcessEventContext } from './process-event'
import { createEmptyState } from './types'
import type { SimulationEvent } from '../../lib/agent-types'
import { transformEventForAll, mergeEventsByTime } from '../../lib/all-sessions'

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200_000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function session(sid: string, label: string, startTime: number): SimulationEvent[] {
  const meta = { label, startTime }
  const raw: SimulationEvent[] = [
    { time: 0, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true } },
    { time: 1, type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } },
    { time: 2, type: 'message', payload: { agent: 'orchestrator', role: 'user', content: 'hello there' } },
    { time: 3, type: 'tool_call_start', payload: { agent: 'worker', tool: 'Read', args: 'a.ts', tool_use_id: `u-${sid}` } },
  ].map(e => ({ ...e, sessionId: sid }) as SimulationEvent)
  return raw.map(e => transformEventForAll(e, meta, 0))
}

test('two sessions with identical agent names stay separate in one simulation', () => {
  const events = mergeEventsByTime([session('A', 'Alpha', 0), session('B', 'Beta', 5000)])
  const { state } = foldEvents(events, createEmptyState(), ctx, { resolveTime: e => e.time })
  assert.equal(state.agents.size, 4)
  const mains = [...state.agents.values()].filter(a => a.isMain)
  assert.deepEqual(mains.map(m => m.name).sort(), ['Alpha', 'Beta'])
  assert.deepEqual(mains.map(m => m.sessionId).sort(), ['A', 'B'])
  // keys stay namespaced, display names are clean, and the user message did not rename the main
  assert.ok(state.agents.has('A::worker') && state.agents.has('B::worker'))
  assert.equal(state.agents.get('A::worker')!.name, 'worker')
  assert.equal(state.agents.get('B::worker')!.parentId, 'B::orchestrator')
  assert.equal(state.timelineEntries.get('B::orchestrator')!.agentName, 'Beta')
  assert.equal(state.toolCalls.size, 2)
  // Mains do not start on top of each other
  const [m1, m2] = mains
  assert.ok(Math.hypot(m1.x - m2.x, m1.y - m2.y) > 500)
})
