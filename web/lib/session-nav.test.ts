import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allTabLabel, nextRunningSessionId, sessionCounts } from './session-nav'

const S = (id: string, status: 'active' | 'completed') => ({ id, status }) as { id: string; status: 'active' | 'completed' }

test('allTabLabel shows live/total only when something is running', () => {
  assert.equal(allTabLabel(3, 12), 'All · 3 live / 12')
  assert.equal(allTabLabel(0, 12), 'All · 12')
})

test('sessionCounts', () => {
  assert.deepEqual(sessionCounts([S('a', 'active'), S('b', 'completed'), S('c', 'active')]), { live: 2, total: 3 })
})

test('nextRunningSessionId cycles active sessions', () => {
  const ss = [S('a', 'completed'), S('b', 'active'), S('c', 'completed'), S('d', 'active')]
  assert.equal(nextRunningSessionId(ss, '__all__'), 'b')
  assert.equal(nextRunningSessionId(ss, 'b'), 'd')
  assert.equal(nextRunningSessionId(ss, 'd'), 'b')
  assert.equal(nextRunningSessionId(ss, 'c'), 'd')
})

test('nextRunningSessionId returns null with no other running session', () => {
  assert.equal(nextRunningSessionId([S('a', 'completed')], null), null)
  assert.equal(nextRunningSessionId([S('a', 'active')], 'a'), null)
  assert.equal(nextRunningSessionId([], null), null)
})
