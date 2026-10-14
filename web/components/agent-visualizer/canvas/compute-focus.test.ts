import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeFocusSet } from './compute-focus'
import type { Edge } from '@/lib/agent-types'

function makeEdge(from: string, to: string, type: Edge['type'] = 'parent-child'): Edge {
  return { id: `edge-${from}-${to}`, from, to, type, opacity: 1 }
}

test('no selection means no focus — returns null so callers draw everything at full opacity', () => {
  const edges = [makeEdge('orchestrator', 'sub-1')]
  assert.equal(computeFocusSet(null, edges), null)
})

test('selected node is always included even with no edges', () => {
  const set = computeFocusSet('orchestrator', [])
  assert.deepEqual([...set!], ['orchestrator'])
})

test('direct neighbors (either direction) are included, two-hop nodes are not', () => {
  const edges = [
    makeEdge('orchestrator', 'sub-1'),
    makeEdge('sub-1', 'sub-2'),
    makeEdge('orchestrator', 'tool-call-1', 'tool'),
  ]
  const set = computeFocusSet('orchestrator', edges)
  assert.ok(set!.has('orchestrator'))
  assert.ok(set!.has('sub-1'), 'direct child must be in focus')
  assert.ok(set!.has('tool-call-1'), 'directly attached tool call must be in focus')
  assert.ok(!set!.has('sub-2'), 'two-hop neighbor must stay dimmed')
})

test('a node that is the "to" endpoint of an edge still counts as a direct neighbor', () => {
  const edges = [makeEdge('sub-1', 'orchestrator')]
  const set = computeFocusSet('orchestrator', edges)
  assert.ok(set!.has('sub-1'))
})
