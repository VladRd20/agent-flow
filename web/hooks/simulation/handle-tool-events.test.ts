import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { handleToolCallStart, handleToolCallEnd } from './handle-tool-events'
import type { MutableEventState, ProcessEventContext } from './process-event'
import type { Agent } from '../../lib/agent-types'

function makeContext(): ProcessEventContext {
  return {
    syncForceSimulation: () => {},
    findToolSlot: () => ({ x: 0, y: 0 }),
    getContextWindowSize: () => 200_000,
    blockIdCounter: { current: 0 },
    skipForceSync: true,
  }
}

function makeAgent(name: string): Agent {
  return {
    id: name,
    name,
    state: 'thinking',
    parentId: null,
    tokensUsed: 0,
    tokensMax: 200_000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    toolCalls: 0,
    timeAlive: 0,
    x: 0, y: 0, vx: 0, vy: 0,
    pinned: false,
    isMain: true,
    spawnTime: 0,
    opacity: 1,
    scale: 1,
    messageBubbles: [],
  }
}

function makeState(agentName: string): MutableEventState {
  const agents = new Map<string, Agent>([[agentName, makeAgent(agentName)]])
  return {
    agents,
    toolCalls: new Map(),
    particles: [],
    edges: [],
    discoveries: [],
    fileAttention: new Map(),
    timelineEntries: new Map(),
    conversations: new Map(),
  }
}

test('two concurrent Read calls on different files both get a tool-call node (dedup no longer drops distinct parallel calls)', () => {
  const state = makeState('agent-1')
  const ctx = makeContext()

  handleToolCallStart({ agent: 'agent-1', tool: 'Read', args: 'fileA.ts', inputData: { file_path: 'fileA.ts' } }, 10, state, ctx)
  handleToolCallStart({ agent: 'agent-1', tool: 'Read', args: 'fileB.ts', inputData: { file_path: 'fileB.ts' } }, 11, state, ctx)

  const running = Array.from(state.toolCalls.values()).filter(tc => tc.state === 'running')
  assert.equal(running.length, 2, 'both distinct Read calls should produce a tool call node')
  const files = running.map(tc => tc.inputData?.file_path).sort()
  assert.deepEqual(files, ['fileA.ts', 'fileB.ts'])
})

test('a literal duplicate report of the same call (same agent/tool/args) within the dedup window is still dropped', () => {
  const state = makeState('agent-1')
  const ctx = makeContext()

  handleToolCallStart({ agent: 'agent-1', tool: 'Read', args: 'fileA.ts', inputData: { file_path: 'fileA.ts' } }, 10, state, ctx)
  handleToolCallStart({ agent: 'agent-1', tool: 'Read', args: 'fileA.ts', inputData: { file_path: 'fileA.ts' } }, 10.5, state, ctx)

  const running = Array.from(state.toolCalls.values()).filter(tc => tc.state === 'running')
  assert.equal(running.length, 1, 'the second, identical report should still be deduped')
})

test('tool_call_end attributes token cost to the call that actually just completed, not an older already-complete same-name call (bug: previously picked the first same agent+tool match in Map order, regardless of running state)', () => {
  const state = makeState('agent-1')
  const ctx = makeContext()

  // An older, already-completed Read of fileA
  handleToolCallStart({ agent: 'agent-1', tool: 'Read', args: 'fileA.ts', inputData: { file_path: 'fileA.ts' } }, 0, state, ctx)
  handleToolCallEnd({ agent: 'agent-1', tool: 'Read', result: 'ok', tokenCost: 100 }, 1, state, ctx)

  // Much later (well outside the 3s dedup window), a new Read of fileB completes
  handleToolCallStart({ agent: 'agent-1', tool: 'Read', args: 'fileB.ts', inputData: { file_path: 'fileB.ts' } }, 100, state, ctx)
  handleToolCallEnd({ agent: 'agent-1', tool: 'Read', result: 'ok', tokenCost: 999 }, 101, state, ctx)

  const fileAAttention = state.fileAttention.get('fileA.ts')
  const fileBAttention = state.fileAttention.get('fileB.ts')
  assert.equal(fileAAttention?.totalTokens, 100, "fileA's own tokenCost from its own completion should be unaffected")
  assert.equal(fileBAttention?.totalTokens, 999, "fileB's tokenCost must be attributed to fileB, not re-added to the older, already-complete fileA call")
})
