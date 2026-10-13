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

test('two truly-concurrent same-tool-name calls by the same agent are disambiguated exactly via tool_use_id, even when args/file are identical (the args-matching heuristic cannot guarantee this)', () => {
  const state = makeState('agent-1')
  const ctx = makeContext()

  // Two genuinely concurrent calls to the same tool, same agent, IDENTICAL
  // args/file — the old heuristic (agent+tool+args/file) cannot tell these
  // apart at all. With real tool_use_ids (as Claude's own tool-call protocol
  // assigns per invocation) they're exact.
  handleToolCallStart({ agent: 'agent-1', tool: 'Bash', args: 'npm test', tool_use_id: 'toolu_AAA' }, 10, state, ctx)
  handleToolCallStart({ agent: 'agent-1', tool: 'Bash', args: 'npm test', tool_use_id: 'toolu_BBB' }, 10.1, state, ctx)

  const running = Array.from(state.toolCalls.values()).filter(tc => tc.state === 'running')
  assert.equal(running.length, 2, 'both concurrent calls should produce distinct tool call nodes despite identical args')

  // Complete them out of start order, each identified only by its tool_use_id.
  handleToolCallEnd({ agent: 'agent-1', tool: 'Bash', result: 'ok-B', tokenCost: 200, tool_use_id: 'toolu_BBB' }, 15, state, ctx)
  handleToolCallEnd({ agent: 'agent-1', tool: 'Bash', result: 'ok-A', tokenCost: 100, tool_use_id: 'toolu_AAA' }, 16, state, ctx)

  const byToolUseId = new Map(Array.from(state.toolCalls.values()).map(tc => [tc.toolUseId, tc]))
  assert.equal(byToolUseId.get('toolu_AAA')?.result, 'ok-A')
  assert.equal(byToolUseId.get('toolu_AAA')?.tokenCost, 100)
  assert.equal(byToolUseId.get('toolu_BBB')?.result, 'ok-B')
  assert.equal(byToolUseId.get('toolu_BBB')?.tokenCost, 200)
  assert.ok(Array.from(state.toolCalls.values()).every(tc => tc.state === 'complete'), 'both calls should be independently completed')
})

test('an exact tool_use_id match dedupes even outside the 3s window (bug: the old code checked elapsed time BEFORE the exact-id check, so a slow call reported twice more than 3s apart — e.g. by both the Hook Server and the Session Watcher for a long Bash command — produced a ghost duplicate node instead of deduping)', () => {
  const state = makeState('agent-1')
  const ctx = makeContext()

  handleToolCallStart({ agent: 'agent-1', tool: 'Bash', args: 'sleep 10', tool_use_id: 'toolu_SLOW' }, 10, state, ctx)
  // Second report of the SAME call, 5s later (past TOOL_DEDUP_WINDOW_S=3),
  // carrying the identical tool_use_id — this is a duplicate report, not a
  // new call, and must dedupe regardless of elapsed time.
  handleToolCallStart({ agent: 'agent-1', tool: 'Bash', args: 'sleep 10', tool_use_id: 'toolu_SLOW' }, 15, state, ctx)

  const running = Array.from(state.toolCalls.values()).filter(tc => tc.state === 'running')
  assert.equal(running.length, 1, 'a late duplicate report with a matching tool_use_id must still dedupe, not create a ghost node')
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
