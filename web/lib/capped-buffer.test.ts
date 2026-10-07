import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { pushCapped } from './capped-buffer'

test('pushCapped appends normally while under the cap', () => {
  const buf = [1, 2, 3]
  pushCapped(buf, 4, 10)
  assert.deepEqual(buf, [1, 2, 3, 4])
})

test('pushCapped trims from the front once the cap is exceeded (bug: session event buffer previously had no cap at all)', () => {
  const buf = [1, 2, 3]
  pushCapped(buf, 4, 3)
  assert.deepEqual(buf, [2, 3, 4], 'oldest item should be dropped to stay at maxSize')
})

test('pushCapped never exceeds maxSize across many pushes', () => {
  const buf: number[] = []
  for (let i = 0; i < 1000; i++) pushCapped(buf, i, 50)
  assert.equal(buf.length, 50)
  assert.deepEqual(buf.slice(0, 3), [950, 951, 952])
  assert.equal(buf[buf.length - 1], 999)
})
