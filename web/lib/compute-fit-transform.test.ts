import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeFitTransform, createFitCache, type FitInput } from './compute-fit-transform'
import type { Agent } from './agent-types'

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'a1',
    name: 'a1',
    isMain: true,
    x: 0,
    y: 0,
    state: 'thinking',
    opacity: 1,
    messageBubbles: [],
    toolCalls: 0,
    tokensUsed: 0,
    ...overrides,
  } as Agent
}

function baseInput(overrides: Partial<FitInput> = {}): FitInput {
  const agents = new Map<string, Agent>([['a1', makeAgent()]])
  return {
    agents,
    toolCalls: new Map(),
    discoveries: [],
    dimensions: { width: 800, height: 600 },
    selectedAgentId: null,
    simTime: 0,
    ...overrides,
  }
}

test('computeFitTransform returns a cached result on an identical call', () => {
  const cache = createFitCache()
  const input = baseInput()
  const first = computeFitTransform(input, cache)
  const second = computeFitTransform(input, cache)
  assert.notEqual(first, null)
  assert.equal(second, first) // same cached object reference
})

test('computeFitTransform recomputes when viewport dimensions change, even if collections are unchanged (bug: used to return a stale transform on resize)', () => {
  const cache = createFitCache()
  const input = baseInput({ dimensions: { width: 800, height: 600 } })

  const before = computeFitTransform(input, cache)
  assert.notEqual(before, null)

  // Same agents/toolCalls/discoveries/selectedAgentId references (no sim event
  // occurred), but the viewport was resized — this must NOT return the stale
  // transform computed under the old dimensions.
  // Small enough that the fit is bound by the viewport, not the max auto-fit zoom
  const resized: FitInput = { ...input, dimensions: { width: 160, height: 120 } }
  const after = computeFitTransform(resized, cache)

  assert.notEqual(after, null)
  assert.notEqual(after!.scale, before!.scale, 'scale must be recomputed for the new, smaller viewport')
})

test('computeFitTransform cache still hits when dimensions are unchanged', () => {
  const cache = createFitCache()
  const input = baseInput()
  const first = computeFitTransform(input, cache)
  const second = computeFitTransform({ ...input }, cache) // new object, same collection refs & dims
  assert.equal(second, first)
})

test('computeFitTransform leaves room for bottom chrome and recomputes when the inset changes', () => {
  const cache = createFitCache()
  const input = baseInput({ dimensions: { width: 400, height: 800 } })
  const plain = computeFitTransform(input, cache)!
  const inset = computeFitTransform({ ...input, bottomInset: 200 }, cache)!
  assert.notEqual(inset, plain)
  // Content center sits at the middle of the visible (non-covered) height
  assert.ok(inset.y < plain.y, 'content is shifted up to clear the bottom bar')
  const noInset = computeFitTransform({ ...input, bottomInset: 0 }, cache)!
  assert.equal(noInset.y, plain.y)
})

test('computeFitTransform centers content in the band between top and bottom chrome', () => {
  const cache = createFitCache()
  const input = baseInput({ dimensions: { width: 844, height: 390 } })
  const plain = computeFitTransform(input, cache)!
  const banded = computeFitTransform({ ...input, topInset: 90, bottomInset: 70 }, cache)!
  assert.ok(banded.scale <= plain.scale, 'a smaller band never zooms in further')
  assert.ok(banded.y > computeFitTransform({ ...input, bottomInset: 70 }, createFitCache())!.y, 'top chrome pushes content down')
  // Chrome taller than 75% of the screen: insets shrink proportionally, never a negative band
  const squeezed = computeFitTransform({ ...input, topInset: 300, bottomInset: 300 }, cache)!
  assert.ok(squeezed.scale > 0 && Number.isFinite(squeezed.y))
})
