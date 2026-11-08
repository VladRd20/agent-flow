import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nextRunningAgentId } from './view-commands'

const A = (entries: Array<[string, string]>) =>
  new Map(entries.map(([id, state]) => [id, { state }])) as unknown as Map<string, { state: never }>

test('nextRunningAgentId cycles through running agents only', () => {
  const agents = A([['a', 'idle'], ['b', 'thinking'], ['c', 'complete'], ['d', 'tool_calling']])
  assert.equal(nextRunningAgentId(agents, null), 'b')
  assert.equal(nextRunningAgentId(agents, 'b'), 'd')
  assert.equal(nextRunningAgentId(agents, 'd'), 'b')
  assert.equal(nextRunningAgentId(agents, 'a'), 'b')
})

test('nextRunningAgentId is null when nothing runs', () => {
  assert.equal(nextRunningAgentId(A([['a', 'idle'], ['b', 'complete']]), null), null)
  assert.equal(nextRunningAgentId(A([]), 'x'), null)
})
