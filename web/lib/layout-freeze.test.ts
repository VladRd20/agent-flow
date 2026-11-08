import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createFreezeState, isLayoutFrozen, readFreezePref, writeFreezePref, FREEZE_STORAGE_KEY, THAW_MS } from './layout-freeze'

function memStore(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial))
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v) } }
}

test('isLayoutFrozen respects user, auto and the thaw window', () => {
  const s = createFreezeState()
  assert.equal(isLayoutFrozen(s, 100), false)
  s.user = true
  assert.equal(isLayoutFrozen(s, 100), true)
  s.thawUntil = 500
  assert.equal(isLayoutFrozen(s, 100), false)
  assert.equal(isLayoutFrozen(s, 500), true)
  s.user = false
  s.auto = true
  assert.equal(isLayoutFrozen(s, 600), true)
})

test('readFreezePref defaults to reduced-motion and honours a saved choice', () => {
  assert.equal(readFreezePref(false, memStore()), false)
  assert.equal(readFreezePref(true, memStore()), true)
  assert.equal(readFreezePref(true, memStore({ [FREEZE_STORAGE_KEY]: '0' })), false)
  assert.equal(readFreezePref(false, memStore({ [FREEZE_STORAGE_KEY]: '1' })), true)
})

test('storage failures never throw', () => {
  const broken = { getItem: () => { throw new Error('blocked') }, setItem: () => { throw new Error('blocked') } }
  assert.equal(readFreezePref(true, broken), true)
  assert.doesNotThrow(() => writeFreezePref(true, broken))
  assert.equal(readFreezePref(false, null), false)
})

test('writeFreezePref round-trips', () => {
  const st = memStore()
  writeFreezePref(true, st)
  assert.equal(readFreezePref(false, st), true)
  writeFreezePref(false, st)
  assert.equal(readFreezePref(true, st), false)
})

test('thaw window covers the d3 cooldown so a new node settles before freezing', () => {
  const cooldownMs = (Math.log(0.001) / Math.log(1 - 0.02)) * (1000 / 60)
  assert.ok(THAW_MS >= cooldownMs)
})
