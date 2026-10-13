import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { computeNextFrame } from './animate'
import { createEmptyState } from './types'
import type { Agent } from '@/lib/agent-types'

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 'orchestrator',
    name: 'orchestrator',
    isMain: true,
    parentId: null,
    x: 0, y: 0, vx: 0, vy: 0,
    pinned: false,
    state: 'complete',
    opacity: 0,
    scale: 0.3,
    toolCalls: 0,
    tokensUsed: 0,
    tokensMax: 200000,
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    timeAlive: 0,
    spawnTime: 0,
    messageBubbles: [],
    ...overrides,
  } as Agent
}

const OPTIONS = { useMockData: false, mockScenarioLength: 0, mockScenarioEndTime: 0 }

test('a main agent that reaches "complete" before its spawn fade-in ever ran still fades in to visible (bug: session-switch replay processes an agent\'s whole history, spawn through completion, in one batch before any animate() tick runs — the old fade-in condition required state !== "complete", so a main agent landing in "complete" with opacity still 0 from spawn was permanently invisible, since isMain also exempts it from the fade-out path that would otherwise move opacity away from 0)', () => {
  const state = createEmptyState({
    agents: new Map([['orchestrator', makeAgent({ opacity: 0, scale: 0.3, state: 'complete' })]]),
  })
  let s = state
  // Simulate several real animation frames after the batch replay landed.
  for (let i = 0; i < 50; i++) {
    s = computeNextFrame(s, 0.1, s.currentTime + 0.1, s.currentTime + 0.1, s, OPTIONS)
  }
  const main = s.agents.get('orchestrator')!
  assert.equal(main.opacity, 1, 'main agent must fade in to fully visible even though it was already "complete" on spawn')
  assert.equal(main.scale, 1)
})

test('a completed non-main agent still fades out to 0 and gets swept (no regression from the opacity-target rework)', () => {
  const state = createEmptyState({
    agents: new Map([['sub-1', makeAgent({ id: 'sub-1', name: 'sub-1', isMain: false, opacity: 1, scale: 1, state: 'complete' })]]),
  })
  let s = state
  for (let i = 0; i < 50; i++) {
    s = computeNextFrame(s, 0.1, s.currentTime + 0.1, s.currentTime + 0.1, s, OPTIONS)
  }
  assert.equal(s.agents.has('sub-1'), false, 'faded-out completed sub-agent should be cleaned up')
})

test('a non-main agent that spawns already-complete (opacity 0) stays invisible and is swept immediately (matches prior behavior: replay only shows agents that survive to the end, not every historical completion)', () => {
  const state = createEmptyState({
    agents: new Map([['sub-1', makeAgent({ id: 'sub-1', name: 'sub-1', isMain: false, opacity: 0, scale: 0.3, state: 'complete' })]]),
  })
  const s = computeNextFrame(state, 0.1, 0.1, 0.1, state, OPTIONS)
  assert.equal(s.agents.has('sub-1'), false)
})
