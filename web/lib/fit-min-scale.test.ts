import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computeFitTransform, createFitCache, minLabelClearScale } from './compute-fit-transform'
import type { Agent } from './agent-types'

const main = (id: string, x: number, y: number, sessionId?: string): Agent => ({
  id, name: id, state: 'idle', parentId: null, tokensUsed: 0, tokensMax: 1, contextBreakdown: {} as Agent['contextBreakdown'],
  toolCalls: 0, timeAlive: 0, x, y, vx: 0, vy: 0, pinned: false, isMain: true, spawnTime: 0, opacity: 1, scale: 1, messageBubbles: [], sessionId,
})

test('no label-clearance zoom floor outside the All view', () => {
  assert.equal(minLabelClearScale([main('a', 0, 0), main('b', 0, 1000)]), 0)
  assert.equal(minLabelClearScale([main('a', 0, 0, 's1')]), 0)
})

test('floor is set by the tightest pair, clear on either axis', () => {
  const s = minLabelClearScale([main('a', 0, 0, 's1'), main('b', 0, 1000, 's2'), main('c', 2000, 0, 's3')])
  // a-b: vertical 1000 -> 105/1000; a-c: horizontal 2000 -> 170/2000 = .085; b-c: min(170/2000, 105/1000)=.085
  assert.ok(Math.abs(s - 0.105) < 1e-9)
})

test('a tall stack that would fit below the floor is clamped and framed from the top', () => {
  const agents = new Map<string, Agent>()
  for (let i = 0; i < 6; i++) agents.set(`m${i}`, main(`m${i}`, 0, i * 1300, `s${i}`))
  const fit = computeFitTransform(
    { agents, toolCalls: new Map(), discoveries: [], dimensions: { width: 390, height: 844 }, selectedAgentId: null, simTime: 0, topInset: 60, bottomInset: 80 },
    createFitCache(),
  )!
  assert.ok(fit.scale >= 105 / 1300 - 1e-9)
  // first main (y=0) lands near the top of the free band, not off-screen or centred
  const screenY = fit.y
  assert.ok(screenY > 60 && screenY < 200)
})
