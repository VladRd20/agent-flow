import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeAgentStates } from './agent-status-summary'
import type { AgentState } from './agent-types'

test('counts active, waiting and error agents and finds the first waiting one', () => {
  const agents = new Map<string, { state: AgentState }>([
    ['a', { state: 'thinking' }],
    ['b', { state: 'tool_calling' }],
    ['c', { state: 'waiting_permission' }],
    ['d', { state: 'idle' }],
    ['e', { state: 'waiting_permission' }],
    ['f', { state: 'error' }],
    ['g', { state: 'complete' }],
  ])
  assert.deepEqual(summarizeAgentStates(agents), { active: 2, waiting: 2, error: 1, firstWaitingId: 'c' })
})

test('empty map yields zeros', () => {
  assert.deepEqual(summarizeAgentStates(new Map()), { active: 0, waiting: 0, error: 0, firstWaitingId: null })
})
