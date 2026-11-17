import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideOverflow, decideFade } from './tab-overflow'
import { shouldShowEmptyOverlay, EMPTY_OVERLAY_GRACE_MS } from './empty-overlay'

describe('decideOverflow', () => {
  it('turns on only when tabs exceed the view', () => {
    assert.equal(decideOverflow(false, 500, 400), true)
    assert.equal(decideOverflow(false, 400, 400), false)
  })
  it('turns off when there is clear room', () => {
    assert.equal(decideOverflow(true, 300, 400), false)
  })
  it('holds state inside the hysteresis band', () => {
    assert.equal(decideOverflow(true, 399, 400), true)
    assert.equal(decideOverflow(false, 399, 400), false)
    assert.equal(decideOverflow(false, 402, 400), false)
    assert.equal(decideOverflow(true, 402, 400), true)
  })
  it('is stable for repeated identical measurements (no feedback)', () => {
    let s = false
    for (let i = 0; i < 10; i++) s = decideOverflow(s, 401, 400)
    assert.equal(s, false)
    for (let i = 0; i < 10; i++) s = decideOverflow(s, 410, 400)
    assert.equal(s, true)
  })
})

describe('decideFade', () => {
  it('none without overflow', () => assert.equal(decideFade(false, 0, 100, 100), 'none'))
  it('end at the start, start at the end, both in the middle', () => {
    assert.equal(decideFade(true, 0, 100, 300), 'end')
    assert.equal(decideFade(true, 200, 100, 300), 'start')
    assert.equal(decideFade(true, 100, 100, 300), 'both')
  })
})

describe('shouldShowEmptyOverlay', () => {
  it('hides during the grace period of an empty canvas', () => {
    assert.equal(shouldShowEmptyOverlay(true, 0), false)
    assert.equal(shouldShowEmptyOverlay(true, EMPTY_OVERLAY_GRACE_MS - 1), false)
  })
  it('shows once empty for the full grace', () => {
    assert.equal(shouldShowEmptyOverlay(true, EMPTY_OVERLAY_GRACE_MS), true)
  })
  it('never shows when agents exist', () => {
    assert.equal(shouldShowEmptyOverlay(false, 99999), false)
  })
})
