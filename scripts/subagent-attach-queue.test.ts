/** Subagent attach queue (concurrency-limited async pre-scan) with a fake delegate. */
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
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
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { scanSubagentsDir, clearSubagentTimers } = require('../extension/src/subagent-watcher') as typeof import('../extension/src/subagent-watcher')
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { iterateFileLinesAsync } = require('../extension/src/fs-utils') as typeof import('../extension/src/fs-utils')

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function makeSession(subagentsDir: string) {
  return {
    subagentWatchers: new Map(), spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDir, subagentsDirWatcher: null,
  } as never as import('../extension/src/protocol').WatchedSession
}
const delegateFor = (session: unknown) => ({
  emit: () => {}, elapsed: () => 0, getSession: () => session, getLastActivityTime: () => 0, resetInactivityTimer: () => {},
}) as never

test('attach queue: all files register at once (dedup), attach eventually, none re-attached', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'af-sub-'))
  try {
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `agent-${i}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n')
    const session = makeSession(dir)
    const parser = {} as never
    scanSubagentsDir(delegateFor(session), parser, 's1')
    assert.equal(session.subagentWatchers.size, 12)
    assert.ok([...session.subagentWatchers.values()].every(s => s.attaching), 'queued files are registered as attaching')
    const states = [...session.subagentWatchers.values()]
    scanSubagentsDir(delegateFor(session), parser, 's1') // second scan must not duplicate
    assert.equal(session.subagentWatchers.size, 12)
    const end = Date.now() + 5000
    while (Date.now() < end && states.some(s => s.attaching)) await sleep(20)
    assert.ok(states.every(s => !s.attaching), 'all attached')
    assert.ok(states.every(s => s.fileSize > 0))
    session.subagentsDirWatcher?.close()
    for (const s of states) s.watcher?.close()
    clearSubagentTimers(session)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('attach queue: a session released while files are queued drops them', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'af-sub-'))
  try {
    for (let i = 0; i < 12; i++) fs.writeFileSync(path.join(dir, `agent-${i}.jsonl`), JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n')
    const session = makeSession(dir)
    scanSubagentsDir(delegateFor(session), {} as never, 's2')
    session.subagentWatchers.clear() // what releaseSessionResources does
    session.subagentsDirWatcher?.close()
    await sleep(300)
    assert.equal(session.subagentWatchers.size, 0)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('iterateFileLinesAsync: small file works with a right-sized buffer', async () => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'af-sub-'))
  try {
    const f = path.join(dir, 'a.jsonl')
    fs.writeFileSync(f, 'one\r\ntwo\nthree')
    const lines: string[] = []
    for await (const l of iterateFileLinesAsync(f, fs.statSync(f).size)) lines.push(l)
    assert.deepEqual(lines, ['one', 'two', 'three'])
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})
