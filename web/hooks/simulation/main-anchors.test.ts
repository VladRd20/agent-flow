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

import { chooseGrid, clusterOutwardAngle } from './main-anchors'

test('partial last row is centred under the full rows', () => {
  const mains = [1, 2, 3, 4, 5].map(i => a(`m${i}`, true, null, i))
  const anchors = computeMainAnchors(mains, 1.6)
  const top = [1, 2, 3].map(i => anchors.get(`m${i}`)!)
  const bottom = [4, 5].map(i => anchors.get(`m${i}`)!)
  assert.equal(top[0].y, top[2].y)
  assert.ok(bottom[0].y > top[0].y)
  const mid = (p: { x: number }[]) => (p[0].x + p[p.length - 1].x) / 2
  assert.ok(Math.abs(mid(top) - mid(bottom)) < 1e-6)
})

test('grid shape follows the viewport aspect', () => {
  assert.equal(chooseGrid(6, 2.2, 1700, 1300).cols, 3)
  assert.ok(chooseGrid(6, 0.46, 1700, 1300).cols <= 2)
  assert.equal(chooseGrid(1, 1.6, 1700, 1300).cols, 1)
  const wide = chooseGrid(5, 1.8, 1700, 1300)
  const phone = chooseGrid(5, 0.46, 1700, 1300)
  assert.ok(wide.cols > phone.cols)
})

test('outward angle points away from the other mains; null outside All', () => {
  const agents = [
    { isMain: true, sessionId: 'A', x: -1000, y: 0 },
    { isMain: true, sessionId: 'B', x: 1000, y: 0 },
  ]
  assert.ok(Math.abs(clusterOutwardAngle({ sessionId: 'B' }, agents)! - 0) < 1e-9)
  assert.ok(Math.abs(Math.abs(clusterOutwardAngle({ sessionId: 'A' }, agents)!) - Math.PI) < 1e-9)
  assert.equal(clusterOutwardAngle({}, agents), null)
  assert.equal(clusterOutwardAngle({ sessionId: 'A' }, [agents[0]]), null)
})
