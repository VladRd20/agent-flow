import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSimClock } from './sim-clock'

test('publish notifies subscribers only on change', () => {
  const clock = createSimClock()
  let n = 0
  const off = clock.subscribe(() => { n++ })
  clock.publish(1, 1)
  clock.publish(1, 1)
  assert.equal(n, 1)
  assert.deepEqual(clock.getSnapshot(), { currentTime: 1, maxTimeReached: 1 })
  off()
  clock.publish(2, 2)
  assert.equal(n, 1)
})
