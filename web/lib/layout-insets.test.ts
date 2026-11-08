import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setKeepOut, getKeepOuts } from './layout-insets'

test('setKeepOut: an unchanged rect does not rebuild the keep-out list', () => {
  setKeepOut('t-a', { x: 1, y: 2, w: 30, h: 40 })
  const first = getKeepOuts()
  setKeepOut('t-a', { x: 1, y: 2, w: 30, h: 40 })
  assert.strictEqual(getKeepOuts(), first, 'same rect re-published must be a no-op')
  setKeepOut('t-a', { x: 1, y: 3, w: 30, h: 40 })
  assert.notStrictEqual(getKeepOuts(), first, 'a moved rect must update')
  setKeepOut('t-a', null)
  const cleared = getKeepOuts()
  setKeepOut('t-a', null)
  assert.strictEqual(getKeepOuts(), cleared, 'clearing an absent key is a no-op')
  assert.ok(!cleared.some((r) => r.y === 3))
})
