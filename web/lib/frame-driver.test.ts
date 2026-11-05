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
