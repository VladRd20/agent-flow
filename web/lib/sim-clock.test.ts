import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSimClock, idleTickDelta, resumeClockTarget } from './sim-clock'

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

test('idleTickDelta caps ordinary ticks but not the first tick after the tab was hidden', () => {
  assert.equal(idleTickDelta(1000, false), 1)
  assert.equal(idleTickDelta(600_000, false), 60)
  assert.equal(idleTickDelta(600_000, true), 600)
  assert.equal(idleTickDelta(-5, true), 0)
})

test('resumeClockTarget adds the hidden wall time, scaled by speed, regardless of the per-frame delta cap', () => {
  assert.equal(resumeClockTarget(100, 25_000, 1), 125)
  assert.equal(resumeClockTarget(100, 25_000, 2), 150)
  assert.equal(resumeClockTarget(100, -5, 1), 100)
})
