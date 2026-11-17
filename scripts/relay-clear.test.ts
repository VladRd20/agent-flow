/**
 * Relay integration (scratch HOME only): /clear in the transcript ends the session once,
 * bookkeeping lines never revive it, a real resumed line does, labels are cleaned.
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import { EventEmitter } from 'events'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return path.join(__dirname, 'vscode-shim.js')
  return origResolve.call(this, request, ...rest)
}

const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'af-relay-clear-'))
const savedEnv = { USERPROFILE: process.env.USERPROFILE, HOME: process.env.HOME }
process.env.USERPROFILE = scratch
process.env.HOME = scratch
const workspace = path.join(scratch, 'ws')
fs.mkdirSync(workspace, { recursive: true })
const encoded = fs.realpathSync(workspace).replace(/[^a-zA-Z0-9]/g, '-')
const projectDir = path.join(scratch, '.claude', 'projects', encoded)
fs.mkdirSync(projectDir, { recursive: true })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
async function waitFor(cond: () => boolean, ms: number) {
  const end = Date.now() + ms
  while (Date.now() < end) { if (cond()) return true; await sleep(50) }
  return cond()
}

let relayRef: { dispose: () => void } | null = null
let sseRes: { emit: (e: string) => boolean } | null = null
const uncaughtBefore = new Set(process.listeners('uncaughtException'))
after(() => {
  sseRes?.emit('close')
  relayRef?.dispose()
  for (const l of process.listeners('uncaughtException')) {
    if (!uncaughtBefore.has(l)) process.removeListener('uncaughtException', l)
  }
  process.env.USERPROFILE = savedEnv.USERPROFILE
  if (savedEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = savedEnv.HOME
  fs.rmSync(scratch, { recursive: true, force: true })
})

const L = (o: unknown) => JSON.stringify(o) + '\n'

test('relay: /clear ends once, bookkeeping does not revive, resume does; labels are clean', async () => {
  const sessA = '11111111-aaaa-bbbb-cccc-000000000001'
  const fileA = path.join(projectDir, `${sessA}.jsonl`)
  fs.writeFileSync(fileA, L({ type: 'user', uuid: 'u1', message: { role: 'user', content: '@"C:\\x\\clip.mp4" Look at this' } }))
  // B was already cleared before the relay started: it must be ended on attach.
  const sessB = '11111111-aaaa-bbbb-cccc-000000000002'
  fs.writeFileSync(path.join(projectDir, `${sessB}.jsonl`),
    L({ type: 'user', uuid: 'b1', message: { role: 'user', content: 'old work' } }) +
    L({ type: 'queue-operation', operation: 'enqueue', content: '/clear' }) +
    L({ type: 'queue-operation', operation: 'dequeue' }) + L({ type: 'cost-state' }))

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createRelay } = require('./relay') as typeof import('./relay')
  const relay = await createRelay({ workspace, runtime: 'claude' }) as unknown as { dispose: () => void; handleSSE: (req: unknown, res: unknown) => void }
  relayRef = relay

  const frames: string[] = []
  const req = new EventEmitter()
  const res: EventEmitter & Record<string, unknown> = Object.assign(new EventEmitter(), {
    writeHead: () => {}, end: () => { res.emit('close') },
    write: (chunk: string) => { frames.push(String(chunk)); return true },
  })
  sseRes = res
  relay.handleSSE(req, res)
  const countB = (needle: string) => frames.filter(f => f.includes(needle) && f.includes(sessB)).length
  const count = (needle: string) => frames.filter(f => f.includes(needle) && f.includes(sessA)).length

  assert.ok(await waitFor(() => count('session-started') >= 1, 4000), 'session started')
  assert.ok(await waitFor(() => countB('session-ended') >= 1, 4000), 'already-cleared session ended on attach')
  assert.equal(count('session-ended'), 0, 'live session A not ended on attach')
  assert.ok(frames.some(f => f.includes('Look at this') && !f.includes('clip.mp4')), 'label stripped of @mention')

  // /clear in the transcript ends the session, exactly once.
  fs.appendFileSync(fileA, L({ type: 'queue-operation', operation: 'enqueue', content: '/clear' }))
  assert.ok(await waitFor(() => count('session-ended') >= 1, 4000), 'session-ended after /clear')

  // Bookkeeping lines: no revival, no second ended.
  fs.appendFileSync(fileA, L({ type: 'queue-operation', operation: 'dequeue' }) + L({ type: 'cost-state' }) + L({ type: 'bridge-session' }))
  await sleep(3500)
  assert.equal(count('session-ended'), 1, 'ended exactly once')
  assert.equal(count('session-started'), 1, 'not revived by bookkeeping')

  // A resumed real user line revives it.
  fs.appendFileSync(fileA, L({ type: 'user', uuid: 'u2', message: { role: 'user', content: 'back again' } }))
  assert.ok(await waitFor(() => count('session-started') >= 2, 4000), 'revived by real conversation line')
})
