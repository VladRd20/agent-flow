import test from 'node:test'
import assert from 'node:assert/strict'
import { createEscapeStack } from './escape-layers'

test('only the topmost layer handles an Escape press', () => {
  const s = createEscapeStack()
  const calls: string[] = []
  s.push(() => calls.push('sheet'))
  const popSearch = s.push(() => calls.push('search'))
  const e1 = {}
  assert.equal(s.dispatch(e1), true)
  assert.deepEqual(calls, ['search'])
  assert.equal(s.wasHandled(e1), true)
  popSearch()
  const e2 = {}
  s.dispatch(e2)
  assert.deepEqual(calls, ['search', 'sheet'])
})

test('with no layer open the press is not handled', () => {
  const s = createEscapeStack()
  const e = {}
  assert.equal(s.dispatch(e), false)
  assert.equal(s.wasHandled(e), false)
})
