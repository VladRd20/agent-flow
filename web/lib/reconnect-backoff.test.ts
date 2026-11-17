import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backoffBaseDelay, backoffDelay } from './reconnect-backoff'

test('base schedule doubles from 1 s and caps at 30 s', () => {
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 50].map(backoffBaseDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000])
})

test('jitter stays within +/-20% of the base delay', () => {
  for (let attempt = 0; attempt < 8; attempt++) {
    const base = backoffBaseDelay(attempt)
    assert.equal(backoffDelay(attempt, () => 0), Math.round(base * 0.8))
    assert.equal(backoffDelay(attempt, () => 0.5), base)
    assert.ok(backoffDelay(attempt, () => 0.999999) <= Math.round(base * 1.2))
  }
})

test('negative or fractional attempts are treated as the first retry', () => {
  assert.equal(backoffBaseDelay(-3), 1000)
  assert.equal(backoffBaseDelay(1.9), 2000)
})
