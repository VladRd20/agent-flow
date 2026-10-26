import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldIgnoreShortcut } from './keyboard-guard'

const base = { key: 'c', ctrlKey: false, metaKey: false, altKey: false, tagName: 'DIV', isContentEditable: false }

test('plain key on body is handled', () => assert.equal(shouldIgnoreShortcut(base), false))
test('ctrl/meta/alt chords pass through', () => {
  assert.equal(shouldIgnoreShortcut({ ...base, ctrlKey: true }), true)
  assert.equal(shouldIgnoreShortcut({ ...base, metaKey: true }), true)
  assert.equal(shouldIgnoreShortcut({ ...base, altKey: true }), true)
})
test('typing targets ignored', () => {
  for (const tagName of ['INPUT', 'textarea', 'SELECT']) assert.equal(shouldIgnoreShortcut({ ...base, tagName }), true)
  assert.equal(shouldIgnoreShortcut({ ...base, isContentEditable: true }), true)
})
test('space on button is native, other keys still work', () => {
  assert.equal(shouldIgnoreShortcut({ ...base, key: ' ', tagName: 'BUTTON' }), true)
  assert.equal(shouldIgnoreShortcut({ ...base, key: 'g', tagName: 'BUTTON' }), false)
})
