import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { processEvent, type ProcessEventContext } from './process-event'
import { computeNextFrame } from './animate'
import { purgeExpiredHidden, HIDDEN_AGENT_TTL_S } from './hidden-agents'
import { createEmptyState, type SimulationState } from './types'
import { createUsageLedger, recordUsage, ledgerTotalTokens } from './usage-ledger'
import { ledgerBreakdown } from '../../components/agent-visualizer/canvas/draw-cost'
import type { Agent, SimulationEvent } from '../../lib/agent-types'

function makeCtx(): ProcessEventContext {
  return {
    syncForceSimulation: () => {},
    findToolSlot: () => ({ x: 10, y: 20 }),
    getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 },
    skipForceSync: true,
  }
}

const OPTIONS = { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 }

function run(events: SimulationEvent[], st = createEmptyState()): SimulationState {
  const ctx = makeCtx()
  for (const e of events) st = processEvent(e, { ...st, currentTime: e.time }, ctx)
  return st
}

const base: SimulationEvent[] = [
  { time: 0, type: 'agent_spawn', payload: { name: 'orchestrator', isMain: true, task: 't' } },
  { time: 1, type: 'agent_spawn', payload: { name: 'child', parent: 'orchestrator', task: 'c' } },
  { time: 2, type: 'context_update', payload: { agent: 'orchestrator', tokens: 1000 } },
  { time: 2, type: 'context_update', payload: { agent: 'child', tokens: 5000 } },
  { time: 3, type: 'tool_call_start', payload: { agent: 'child', tool: 'Read', args: 'a.ts', inputData: { file_path: 'a.ts' }, tool_use_id: 'u1' } },
  { time: 3.1, type: 'tool_call_end', payload: { agent: 'child', tool: 'Read', result: 'ok', tokenCost: 300, tool_use_id: 'u1' } },
  { time: 4, type: 'agent_complete', payload: { name: 'child' } },
]

test('ledger records agents and tool calls from events', () => {
  const st = run(base)
  assert.equal(ledgerTotalTokens(st.usageLedger), 6300)
  const { toolList } = ledgerBreakdown(st.usageLedger)
  assert.deepEqual(toolList.map(t => [t.name, t.tokens]), [['Read', 300]])
})

test('removing the agent, expiring it from hidden and pruning tool calls leaves totals unchanged', () => {
  let st = run(base)
  const before = ledgerBreakdown(st.usageLedger)
  // Fade the completed child out of the graph and prune its tool calls
  for (let i = 0; i < 400; i++) {
    st = computeNextFrame(st, 0.1, st.currentTime + 0.1, st.currentTime + 0.1, st, OPTIONS)
  }
  assert.equal(st.agents.has('child'), false)
  assert.equal(st.toolCalls.size, 0)
  // Expire the hidden entry as well
  const hidden = purgeExpiredHidden(st.hiddenAgents, st.currentTime + HIDDEN_AGENT_TTL_S + 1)
  assert.equal(hidden.size, 0)
  const after = ledgerBreakdown(st.usageLedger)
  assert.equal(after.totalTokens, before.totalTokens)
  assert.equal(after.totalCost, before.totalCost)
  assert.deepEqual(after.toolList, before.toolList)
  assert.ok(after.agentBreakdown.some(a => a.name === 'child'))
})

test('sweeping an agent that was never recorded still snapshots its usage first', () => {
  const agent = { id: 's', name: 's', isMain: false, parentId: null, x: 0, y: 0, vx: 0, vy: 0, pinned: false,
    state: 'complete', opacity: 0, scale: 0.3, toolCalls: 0, tokensUsed: 4242, tokensMax: 200000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    timeAlive: 0, spawnTime: 0, messageBubbles: [] } as Agent
  const st = createEmptyState({ agents: new Map([['s', agent]]) })
  const next = computeNextFrame(st, 0.1, 0.1, 0.1, st, OPTIONS)
  assert.equal(next.agents.has('s'), false)
  assert.equal(ledgerTotalTokens(next.usageLedger), 4242)
})

test('duplicate updates, compaction and a resumed id never double count or lower the total', () => {
  let st = run(base)
  const total = ledgerTotalTokens(st.usageLedger)
  // Replay of identical events
  st = run(base.slice(2, 4), st)
  assert.equal(ledgerTotalTokens(st.usageLedger), total)
  // Lower value (compaction) does not reduce
  st = run([{ time: 5, type: 'context_update', payload: { agent: 'orchestrator', tokens: 200 } }], st)
  assert.equal(ledgerTotalTokens(st.usageLedger), total)
  // Larger value for the same id replaces (not adds)
  st = run([{ time: 6, type: 'context_update', payload: { agent: 'orchestrator', tokens: 1500 } }], st)
  assert.equal(ledgerTotalTokens(st.usageLedger), total + 500)
})

test('recordUsage returns the same ledger when nothing grew, and a fresh ledger starts empty', () => {
  const st = run(base)
  assert.equal(recordUsage(st.usageLedger, st.agents, st.toolCalls), st.usageLedger)
  assert.equal(ledgerTotalTokens(createUsageLedger()), 0)
  assert.equal(ledgerTotalTokens(createEmptyState().usageLedger), 0)
})
