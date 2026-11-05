import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildGhostView, createGhostViewMemo, GHOST_ALPHA } from './ghost-view'
import type { Agent, Edge } from '@/lib/agent-types'

function agent(id: string, o: Partial<Agent> = {}): Agent {
  return {
    id, name: id, isMain: false, parentId: 'orchestrator', x: 10, y: 20, vx: 3, vy: 3, pinned: false,
    state: 'complete', opacity: 0, scale: 0.8, toolCalls: 7, tokensUsed: 5, tokensMax: 10,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    timeAlive: 0, spawnTime: 0, messageBubbles: [], ...o,
  } as Agent
}

const live = () => new Map([['orchestrator', agent('orchestrator', { isMain: true, parentId: null, state: 'idle', opacity: 1 })]])

test('returns inputs untouched when nothing is hidden', () => {
  const agents = live(), edges: Edge[] = []
  const v = buildGhostView(agents, edges, new Map())
  assert.equal(v.agents, agents)
  assert.equal(v.edges, edges)
})

test('adds hidden agents as dimmed ghosts with an edge to the parent, without mutating inputs', () => {
  const agents = live(), edges: Edge[] = []
  const hidden = new Map([['worker', { agent: agent('worker'), hiddenAt: 0 }]])
  const v = buildGhostView(agents, edges, hidden)
  const g = v.agents.get('worker')!
  assert.equal(g.ghost, true)
  assert.equal(g.opacity, GHOST_ALPHA)
  assert.equal(g.state, 'complete')
  assert.equal(g.toolCalls, 7, 'stats kept for the detail card')
  assert.equal(g.x, 10)
  assert.ok(v.edges.some(e => e.from === 'orchestrator' && e.to === 'worker' && e.opacity === GHOST_ALPHA))
  assert.equal(agents.size, 1, 'live map untouched')
  assert.equal(edges.length, 0)
  assert.equal(hidden.get('worker')!.agent.opacity, 0, 'hidden entry untouched')
})

test('a live agent with the same name wins; ghost-parent edges to live children are added', () => {
  const agents = live()
  agents.set('worker', agent('worker', { state: 'idle', opacity: 1 }))
  agents.set('kid', agent('kid', { parentId: 'old', state: 'idle', opacity: 1 }))
  const hidden = new Map([
    ['worker', { agent: agent('worker'), hiddenAt: 0 }],
    ['old', { agent: agent('old'), hiddenAt: 0 }],
  ])
  const v = buildGhostView(agents, [], hidden)
  assert.equal(v.agents.get('worker')!.ghost, undefined)
  assert.ok(v.agents.get('old')!.ghost)
  assert.ok(v.edges.some(e => e.from === 'old' && e.to === 'kid'))
  assert.ok(v.edges.some(e => e.from === 'orchestrator' && e.to === 'old'))
})

test('memo reuses the result for identical inputs', () => {
  const memo = createGhostViewMemo()
  const agents = live(), edges: Edge[] = [], hidden = new Map([['w', { agent: agent('w'), hiddenAt: 0 }]])
  assert.equal(memo(agents, edges, hidden), memo(agents, edges, hidden))
  assert.notEqual(memo(agents, edges, hidden), memo(live(), edges, hidden))
})
