import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeDegreeMap, getNodeSizeMultiplier } from './node-size'
import type { Edge } from '@/lib/agent-types'

function makeEdge(from: string, to: string, type: Edge['type'] = 'parent-child'): Edge {
  return { id: `edge-${from}-${to}`, from, to, type, opacity: 1 }
}

test('computeDegreeMap counts both endpoints of every edge', () => {
  const edges = [
    makeEdge('orchestrator', 'sub-1'),
    makeEdge('orchestrator', 'sub-2'),
    makeEdge('orchestrator', 'tool-1', 'tool'),
  ]
  const map = computeDegreeMap(edges)
  assert.equal(map.get('orchestrator'), 3)
  assert.equal(map.get('sub-1'), 1)
  assert.equal(map.get('sub-2'), 1)
  assert.equal(map.get('tool-1'), 1)
})

test('getNodeSizeMultiplier is 1 for a node with no edges', () => {
  const map = computeDegreeMap([])
  assert.equal(getNodeSizeMultiplier('lonely', map), 1)
})

test('getNodeSizeMultiplier grows with degree but is capped', () => {
  const edges = Array.from({ length: 50 }, (_, i) => makeEdge('hub', `leaf-${i}`))
  const map = computeDegreeMap(edges)
  const multiplier = getNodeSizeMultiplier('hub', map)
  assert.ok(multiplier > 1, 'a busy node should be larger than baseline')
  assert.ok(multiplier <= 1.6, 'size growth must stay capped')
})
