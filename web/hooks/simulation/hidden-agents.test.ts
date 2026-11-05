import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeNextFrame } from './animate'
import { createEmptyState, type SimulationState } from './types'
import { processEvent, type ProcessEventContext } from './process-event'
import { HIDDEN_AGENT_TTL_S } from './hidden-agents'
import { snapVisualState } from './snap-visual-state'
import type { Agent } from '@/lib/agent-types'

const OPTIONS = { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 }

const ctx: ProcessEventContext = {
  syncForceSimulation: () => {},
  findToolSlot: () => ({ x: 0, y: 0 }),
  getContextWindowSize: () => 200000,
  blockIdCounter: { current: 0 },
  skipForceSync: true,
}

function agent(id: string, overrides: Partial<Agent> = {}): Agent {
  return {
    id, name: id, isMain: false, parentId: 'orchestrator',
    x: 10, y: 20, vx: 0, vy: 0, pinned: false,
    state: 'idle', opacity: 1, scale: 1,
    toolCalls: 7, tokensUsed: 12345, tokensMax: 200000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    timeAlive: 0, spawnTime: 0, messageBubbles: [],
    ...overrides,
  } as Agent
}

function withSubagent(overrides: Partial<Agent> = {}): SimulationState {
  return createEmptyState({
    agents: new Map([
      ['orchestrator', agent('orchestrator', { isMain: true, parentId: null })],
      ['worker', agent('worker', overrides)],
    ]),
    edges: [{ id: 'edge-orchestrator-worker', from: 'orchestrator', to: 'worker', type: 'parent-child', opacity: 1 }],
  })
}

/** Advance frames until `t` (seconds). */
function runUntil(s: SimulationState, t: number, step = 0.1): SimulationState {
  while (s.currentTime < t) {
    const next = s.currentTime + step
    s = computeNextFrame(s, step, next, next, s, OPTIONS)
  }
  return s
}

function at(s: SimulationState, t: number): SimulationState { return { ...s, currentTime: t } }

test('a finished sub-agent fades out, then leaves the graph but is kept hidden', () => {
  let s = withSubagent({ state: 'complete', completeTime: 0 })
  s = runUntil(s, 3)
  assert.equal(s.agents.has('worker'), false, 'not in the graph')
  assert.ok(s.hiddenAgents.has('worker'), 'kept hidden')
  assert.equal(s.edges.some(e => e.to === 'worker'), false, 'its edge is removed')
  assert.ok(s.agents.has('orchestrator'))
})

test('agent_spawn for a hidden agent restores it with its stats, edge and a Resumed timeline block', () => {
  let s = withSubagent({ state: 'complete', completeTime: 0 })
  s.timelineEntries.set('worker', { id: 'timeline-worker', agentId: 'worker', agentName: 'worker', startTime: 0, endTime: 0, blocks: [] })
  s = runUntil(s, 3)
  s = processEvent({ time: 5, type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } }, at(s, 5), ctx)
  const w = s.agents.get('worker')!
  assert.ok(w, 'back in the graph')
  assert.equal(w.state, 'idle')
  assert.equal(w.toolCalls, 7, 'stats preserved')
  assert.equal(w.tokensUsed, 12345)
  assert.equal(w.x, 10, 'keeps its position')
  assert.equal(s.hiddenAgents.has('worker'), false)
  assert.ok(s.edges.some(e => e.from === 'orchestrator' && e.to === 'worker'), 'edge rebuilt')
  const entry = s.timelineEntries.get('worker')!
  assert.equal(entry.endTime, undefined)
  assert.equal(entry.blocks.at(-1)?.label, 'Resumed')
  s = runUntil(s, 7)
  assert.ok(s.agents.get('worker')!.opacity > 0.9, 'fades back in')
})

test('a new tool call from a hidden agent also revives it (resume paths without agent_spawn)', () => {
  let s = withSubagent({ state: 'complete', completeTime: 0 })
  s = runUntil(s, 3)
  s = processEvent({ time: 5, type: 'tool_call_start', payload: { agent: 'worker', tool: 'Read', args: 'x.ts' } }, at(s, 5), ctx)
  assert.ok(s.agents.has('worker'))
  assert.notEqual(s.agents.get('worker')!.state, 'complete')
})

test('hidden agents are deleted after 15 minutes', () => {
  let s = withSubagent({ state: 'complete', completeTime: 0 })
  s = runUntil(s, 3)
  const hiddenAt = s.hiddenAgents.get('worker')!.hiddenAt
  s = runUntil(at(s, hiddenAt + HIDDEN_AGENT_TTL_S - 1), hiddenAt + HIDDEN_AGENT_TTL_S - 0.5)
  assert.ok(s.hiddenAgents.has('worker'), 'still hidden just before the TTL')
  s = runUntil(s, hiddenAt + HIDDEN_AGENT_TTL_S + 0.5)
  assert.equal(s.hiddenAgents.has('worker'), false, 'gone after the TTL')
  // A spawn after expiry creates a fresh node, not a revived one
  s = processEvent({ time: s.currentTime, type: 'agent_spawn', payload: { name: 'worker', parent: 'orchestrator' } }, s, ctx)
  assert.equal(s.agents.get('worker')!.toolCalls, 0)
})

test('main agents are never hidden', () => {
  let s = createEmptyState({ agents: new Map([['orchestrator', agent('orchestrator', { isMain: true, parentId: null, state: 'complete', completeTime: 0 })]]) })
  s = runUntil(s, 3)
  assert.ok(s.agents.has('orchestrator'))
  assert.equal(s.hiddenAgents.size, 0)
})

test('seeking keeps recently finished sub-agents hidden and drops expired ones', () => {
  const s = createEmptyState({
    agents: new Map([
      ['orchestrator', agent('orchestrator', { isMain: true, parentId: null })],
      ['recent', agent('recent', { state: 'complete', completeTime: 1000 })],
      ['old', agent('old', { state: 'complete', completeTime: 0 })],
    ]),
  })
  const snapped = snapVisualState(s, 1000 + 60)
  assert.equal(snapped.agents.has('recent'), false)
  assert.ok(snapped.hiddenAgents.has('recent'))
  assert.equal(snapped.hiddenAgents.has('old'), false)
})
