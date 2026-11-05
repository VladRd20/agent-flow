import { test, beforeEach } from 'node:test'
import { strict as assert } from 'node:assert'
import { FrameDriver } from './frame-driver'

// Minimal browser stubs: a manual rAF queue we can step and inspect.
let rafQueue: Map<number, (ts: number) => void>
let nextId: number
let now: number
const g = globalThis as Record<string, unknown>
g.document = { hidden: false, addEventListener: () => {} }
g.window = {} // no matchMedia: fine-pointer desktop, no throttling
g.requestAnimationFrame = (cb: (ts: number) => void) => { const id = nextId++; rafQueue.set(id, cb); return id }
g.cancelAnimationFrame = (id: number) => { rafQueue.delete(id) }

/** Run every queued rAF callback once (one "frame"), 20ms apart. */
function frame() {
  now += 20
  const cbs = [...rafQueue.values()]
  rafQueue.clear()
  for (const cb of cbs) cb(now)
}

beforeEach(() => { rafQueue = new Map(); nextId = 1; now = 1000 })

test('wake() from inside a tick keeps exactly one pending frame (bug: forked a second rAF chain per frame)', () => {
  const d = new FrameDriver()
  let ticks = 0
  d.register({ name: 'drag', order: 0, tick: () => { ticks++; d.wake(); return 'full' } })
  for (let i = 0; i < 10; i++) {
    frame()
    assert.ok(rafQueue.size <= 1, `frame ${i}: ${rafQueue.size} pending rAF callbacks`)
  }
  assert.equal(ticks, 10)
})

/** Drive one second of vsyncs at `hz` (optionally jittered) and count 'full' ticks. */
function ticksPerSecond(hz: number, jitterMs = 0): number {
  const d = new FrameDriver()
  let ticks = 0
  d.register({ name: 'anim', order: 0, tick: () => { ticks++; return 'full' } })
  const period = 1000 / hz
  for (let i = 1; i <= hz; i++) {
    const ts = 1000 + i * period + (i % 2 ? jitterMs : -jitterMs)
    const cbs = [...rafQueue.values()]
    rafQueue.clear()
    for (const cb of cbs) cb(ts)
  }
  return ticks
}

test('animating frames are capped at ~120fps on fast displays', () => {
  for (const hz of [144, 165, 240]) {
    const n = ticksPerSecond(hz)
    assert.ok(n >= 115 && n <= 122, `${hz}Hz -> ${n} ticks/s`)
  }
})

test('120Hz and 60Hz displays run at their full rate, even with timestamp jitter', () => {
  assert.ok(ticksPerSecond(120, 0.4) >= 118, '120Hz')
  assert.ok(ticksPerSecond(60, 0.4) >= 59, '60Hz')
})

test('a wake requested during an otherwise idle tick still schedules the next frame', () => {
  const d = new FrameDriver()
  let n = 0
  d.register({ name: 't', order: 0, tick: () => { n++; if (n === 1) d.wake(); return 'idle' } })
  frame() // tick 1: idle, but woke itself
  assert.equal(rafQueue.size, 1)
  frame() // tick 2: idle, no wake
  assert.equal(rafQueue.size, 0)
  assert.ok(d.isIdle)
  d.wake()
  assert.equal(rafQueue.size, 1)
})
