import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import type { Agent, ToolCallNode } from '@/lib/agent-types'
import { beginOverlayFrame, resetOverlayState, getOverlayFrame } from './overlay-layout'
import { rectsOverlap, type Rect } from './overlay-rects'
import { computeFitTransform, createFitCache } from '@/lib/compute-fit-transform'

function fakeCtx(): CanvasRenderingContext2D {
  const ctx = {
    font: '',
    measureText(text: string) {
      const px = parseFloat(this.font) || 10
      return { width: text.length * px * 0.6 }
    },
  }
  return ctx as unknown as CanvasRenderingContext2D
}

function makeAgent(i: number, x: number, y: number): Agent {
  return {
    id: `a${i}`, name: i === 0 ? 'Dispatch board processor' : `AP${i} Apple phone number`,
    state: i % 3 === 0 ? 'thinking' : 'idle', parentId: i === 0 ? null : 'a0',
    tokensUsed: 900_000 + i * 120_000, tokensMax: 1_000_000, // several are over capacity
    contextBreakdown: { systemPrompt: 1, userMessages: 1, toolResults: 1, reasoning: 1, subagentResults: 1 },
    toolCalls: 0, timeAlive: 1, x, y, vx: 0, vy: 0, pinned: false, isMain: i === 0,
    spawnTime: i, opacity: 1, scale: 1, messageBubbles: [],
  } as unknown as Agent
}

function layout(count: number, vw: number, vh: number, tools: ToolCallNode[] = []) {
  resetOverlayState()
  const agents = new Map<string, Agent>()
  // spread nodes on rings around the origin, then fit them like the camera would
  for (let i = 0; i < count; i++) {
    const ring = i === 0 ? 0 : 1 + Math.floor((i - 1) / 7)
    const ang = ((i - 1) % 7) / 7 * Math.PI * 2
    agents.set(`a${i}`, makeAgent(i, Math.cos(ang) * 220 * ring, Math.sin(ang) * 220 * ring))
  }
  const toolMap = new Map(tools.map(t => [t.id, t]))
  const fit = computeFitTransform({
    agents, toolCalls: toolMap, discoveries: [], dimensions: { width: vw, height: vh },
    selectedAgentId: null, simTime: 0, bottomInset: 120,
  }, createFitCache())!
  const frame = beginOverlayFrame({
    ctx: fakeCtx(), agents, toolCalls: toolMap, transform: fit, viewport: { width: vw, height: vh }, dpr: 3,
    deltaTime: 1, simTime: 0, selectedAgentId: null, hoveredAgentId: null, focusSet: null, degreeMap: null,
  })
  return { frame, agents }
}

test('15 nodes on a 390px screen: shown label plates never overlap each other', () => {
  const { frame } = layout(15, 390, 844)
  const shown = [...frame.labels.values()].filter(l => l.shown)
  assert.ok(shown.length >= 3, 'a useful number of labels survive declutter')
  const forced = shown.filter(l => l.id === 'a0')
  assert.equal(forced.length, 1, 'main label is always shown')
  for (let i = 0; i < shown.length; i++) {
    for (let j = i + 1; j < shown.length; j++) {
      if (shown[i].id === 'a0' || shown[j].id === 'a0') continue // forced may overlap by design
      assert.equal(rectsOverlap(shown[i].rect, shown[j].rect), false, `${shown[i].id} vs ${shown[j].id}`)
    }
  }
})

test('label plates stay inside the viewport', () => {
  const { frame } = layout(15, 390, 844)
  for (const l of frame.labels.values()) {
    if (!l.shown) continue
    assert.ok(l.rect.x >= 0 && l.rect.x + l.rect.w <= 390 + 0.5, `${l.id} horizontal`)
    assert.ok(l.rect.y >= 0 && l.rect.y + l.rect.h <= 844 + 0.5, `${l.id} vertical`)
  }
})

test('label stack uses one consistent column width for plate, bar and token text', () => {
  const { frame } = layout(4, 390, 844)
  for (const l of frame.labels.values()) {
    if (l.mode !== 'full') continue
    assert.ok(l.rect.w >= l.columnW, 'plate encloses the column')
    assert.ok(l.rect.w <= l.columnW + 24, 'plate is not wider than column + padding')
  }
})

test('label geometry is stable across breathing (layout ignores per-frame r wobble)', () => {
  const a = layout(6, 390, 844).frame.labels.get('a1')!.rect
  const b = layout(6, 390, 844).frame.labels.get('a1')!.rect
  assert.deepEqual(a, b)
})

test('tool cards are clamped into the viewport', () => {
  const tool = {
    id: 't1', agentId: 'a0', toolName: 'Bash', state: 'running', args: 'sed -i s/freeze=False/ app.py && npm run build',
    x: -900, y: 40, startTime: 0, opacity: 1,
  } as unknown as ToolCallNode
  resetOverlayState()
  const agents = new Map([['a0', makeAgent(0, 0, 0)]])
  const frame = beginOverlayFrame({
    ctx: fakeCtx(), agents, toolCalls: new Map([['t1', tool]]),
    transform: { x: 195, y: 400, scale: 0.5 }, viewport: { width: 390, height: 844 }, dpr: 2,
    deltaTime: 1, simTime: 0, selectedAgentId: null, hoveredAgentId: null, focusSet: null, degreeMap: null,
  })
  // anchor is at screen x = -900*0.5+195 = -255 -> beyond the slack, so it is skipped, not drawn clipped
  assert.equal(frame.tools.has('t1'), false)

  const near = { ...tool, x: -420 } as ToolCallNode // anchor at screen x = -15: just off-screen
  const f2 = beginOverlayFrame({
    ctx: fakeCtx(), agents, toolCalls: new Map([['t1', near]]),
    transform: { x: 195, y: 400, scale: 0.5 }, viewport: { width: 390, height: 844 }, dpr: 2,
    deltaTime: 1, simTime: 0, selectedAgentId: null, hoveredAgentId: null, focusSet: null, degreeMap: null,
  })
  const plan = f2.tools.get('t1')!
  assert.ok(plan.rect.x >= 0, 'clamped to the left edge')
  assert.equal(plan.displaced, true, 'leader line to the true anchor')
  assert.ok(getOverlayFrame() === f2)
})

test('over-capacity agents flag the bar and keep the segments inside it', () => {
  const { frame } = layout(3, 390, 844)
  const l = frame.labels.get('a2')!
  assert.equal(l.over, true)
  assert.ok(l.bar && l.bar.fill === 1 && l.bar.over)
  const _r: Rect = l.rect
  assert.ok(_r.w > 0)
})
