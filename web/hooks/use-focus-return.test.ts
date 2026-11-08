import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldRestoreFocus, type FocusLike } from './use-focus-return'

const trigger: FocusLike = { isConnected: true, focus: () => {} }

test('restores when focus was dropped', () => {
  assert.equal(shouldRestoreFocus(null, trigger), true)
  assert.equal(shouldRestoreFocus({ tagName: 'BODY' }, trigger), true)
  assert.equal(shouldRestoreFocus({ isConnected: false }, trigger), true)
  assert.equal(shouldRestoreFocus({ isConnected: true, closest: () => ({}) }, trigger), true)
})

test('leaves focus alone when the user moved it elsewhere', () => {
  assert.equal(shouldRestoreFocus({ isConnected: true, closest: () => null }, trigger), false)
})

test('never restores to a missing or detached trigger', () => {
  assert.equal(shouldRestoreFocus(null, null), false)
  assert.equal(shouldRestoreFocus(null, { isConnected: false, focus: () => {} }), false)
  assert.equal(shouldRestoreFocus(null, { isConnected: true }), false)
})
