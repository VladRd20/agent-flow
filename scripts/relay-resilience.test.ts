/**
 * Integration tests for relay.ts against a scratch HOME (never the real ~/.claude).
 * Items 5 (failed attach is retried, no zombie) and 6 (a bad line does not crash).
 */
import { test, after } from 'node:test'
import { strict as assert } from 'node:assert'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// relay.ts imports 'vscode' (via hook-server); the bundles alias it to a shim.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require('module')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request: string, ...rest: unknown[]) {
  if (request === 'vscode') return path.join(__dirname, 'vscode-shim.js')
  return origResolve.call(this, request, ...rest)
}

const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'af-relay-test-'))
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
const uncaughtBefore = new Set(process.listeners('uncaughtException'))
after(() => {
  relayRef?.dispose()
  for (const l of process.listeners('uncaughtException')) {
    if (!uncaughtBefore.has(l)) process.removeListener('uncaughtException', l)
  }
  process.env.USERPROFILE = savedEnv.USERPROFILE
  if (savedEnv.HOME === undefined) delete process.env.HOME; else process.env.HOME = savedEnv.HOME
  fs.rmSync(scratch, { recursive: true, force: true })
})

test('relay: failed attach warns and is retried on the next scan; a bad line does not crash', async () => {
  const warns: string[] = []
  const origWarn = console.warn
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')) }
  try {
    // Make the attach-time statSync throw once at attach time.
    const brokenPath = path.join(projectDir, 'broken-session.jsonl')
    fs.writeFileSync(brokenPath, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'b1' }) + '\n')
    let attachCalls = 0
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRelay, relayTestHooks } = require('./relay') as typeof import('./relay')
    relayTestHooks.beforeAttach = (id) => {
      if (id === 'broken-session' && ++attachCalls === 1) throw Object.assign(new Error('ENOENT: simulated'), { code: 'ENOENT' })
    }
    relayTestHooks.beforeLine = (line) => { if (line.includes('POISON')) throw new TypeError('poisoned line') }
    const relay = await createRelay({ workspace, runtime: 'claude' })
    relayRef = relay

    assert.ok(await waitFor(() => warns.some(w => w.includes('Failed to attach session broken-s')), 3000), 'attach failure is warned')

    // Trigger another scan via the project-dir watcher: the zombie entry must be
    // gone, so the same session is attached again (second attach attempt).
    fs.writeFileSync(path.join(projectDir, 'trigger.jsonl'), '')
    assert.ok(await waitFor(() => attachCalls >= 2, 4000), `retried (attach calls: ${attachCalls})`)
    await sleep(300)
    assert.equal(warns.filter(w => w.includes('Failed to attach session broken-s')).length, 1, 'retry succeeded')

    // Good session followed by a line that parses as JSON but is hostile.
    const good = path.join(projectDir, 'good-session.jsonl')
    fs.writeFileSync(good, JSON.stringify({ type: 'user', message: { role: 'user', content: 'hi' }, uuid: 'u1' }) + '\n')
    fs.writeFileSync(path.join(projectDir, 'trigger2.jsonl'), '')
    await sleep(1500)
    const hostile = [
      JSON.stringify({ type: 'assistant', message: null }),
      JSON.stringify({ type: 'assistant', message: { content: [null, 5, { type: 'tool_use' }] } }),
      JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: {} }] } }),
      'not json at all',
      JSON.stringify({ type: 'user', message: { content: 'POISON' } }),
      JSON.stringify({ type: 'user', message: { content: 'POISON again' } }),
    ].join('\n') + '\n'
    fs.appendFileSync(good, hostile)
    await sleep(1000)
    // The throw is contained (no uncaughtException -> process.exit) and warned once, not per line.
    assert.ok(await waitFor(() => warns.some(w => w.includes('Transcript line processing failed')), 2000), 'bad line warned')
    assert.equal(warns.filter(w => w.includes('Transcript line processing failed')).length, 1, 'rate limited to one per session per minute')
  } finally {
    console.warn = origWarn
  }
})
