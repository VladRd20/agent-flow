import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeMainAnchors, computeForceTargets, type AnchorAgent } from './main-anchors'

const a = (id: string, isMain: boolean, parentId: string | null, spawnTime: number): AnchorAgent => ({ id, isMain, parentId, spawnTime })

test('a single main gets no anchors (single-session layout untouched)', () => {
  assert.equal(computeMainAnchors([a('m', true, null, 0), a('s', false, 'm', 1)]).size, 0)
  assert.equal(computeForceTargets([a('m', true, null, 0)]).size, 0)
})

test('mains get distinct, well separated cells', () => {
  const anchors = computeMainAnchors([1, 2, 3, 4, 5].map(i => a(`m${i}`, true, null, i)))
  assert.equal(anchors.size, 5)
  const pts = [...anchors.values()]
  for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    assert.ok(Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) >= 900)
  }
})

test('sub-agents are leashed to their own main cell', () => {
  const t = computeForceTargets([a('m1', true, null, 0), a('m2', true, null, 1), a('s', false, 'm2', 2)])
  assert.equal(t.get('s')!.x, t.get('m2')!.x)
  assert.ok(t.get('m2')!.strength > t.get('s')!.strength)
})
