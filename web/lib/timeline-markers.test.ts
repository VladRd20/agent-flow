import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { pickMarkerInterval, formatMarker } from './timeline-markers'

test('pickMarkerInterval keeps labels apart on a narrow phone bar (bug: 60 labels in 270px for a 10-min session)', () => {
  const step = pickMarkerInterval(600, 270, 48)
  assert.ok((step / 600) * 270 >= 48, `step ${step} too dense`)
  assert.ok(600 / step <= 6)
})

test('pickMarkerInterval picks fine steps for short sessions on a wide bar', () => {
  assert.equal(pickMarkerInterval(10, 600, 40), 1)
  assert.equal(pickMarkerInterval(60, 600, 40), 5)
})

test('pickMarkerInterval survives degenerate and very long inputs', () => {
  assert.ok(pickMarkerInterval(0, 300, 40) > 0)
  assert.ok(pickMarkerInterval(10, 0, 40) > 0)
  const long = pickMarkerInterval(48 * 3600, 300, 48)
  assert.ok(long % 3600 === 0 && (long / (48 * 3600)) * 300 >= 48)
})

test('formatMarker', () => {
  assert.equal(formatMarker(45), '45s')
  assert.equal(formatMarker(90), '1:30')
  assert.equal(formatMarker(600), '10m')
  assert.equal(formatMarker(3720), '1h02')
})
