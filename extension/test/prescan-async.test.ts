/**
 * prescanExistingContentAsync: must produce exactly what the synchronous
 * prescan does, without monopolising the event loop on a big transcript.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TranscriptParser, TranscriptParserDelegate } from '../src/transcript-parser'
import { iterateFileLines, iterateFileLinesAsync } from '../src/fs-utils'
import { WatchedSession } from '../src/protocol'

const SID = 's1'

function makeSession(): WatchedSession {
  return {
    sessionId: SID, filePath: '/tmp/s1.jsonl', fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: 0, pendingToolCalls: new Map(), seenToolUseIds: new Set(), seenMessageHashes: new Set(),
    sessionDetected: false, sessionCompleted: false, lastActivityTime: 0, inactivityTimer: null,
    subagentWatchers: new Map(), spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null, label: 'S', labelSet: false, model: null,
    modelDetectedAgents: new Map(), permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 100, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    pendingCatchUpSpawns: [],
  }
}

function makeParser(session: WatchedSession) {
  const delegate: TranscriptParserDelegate = {
    emit: () => {},
    elapsed: () => 0,
    getSession: (id) => (id === SID ? session : undefined),
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  return new TranscriptParser(delegate)
}

/** Deterministic synthetic transcript: n turns of user / assistant+tool_use / tool_result, plus Agent launches. */
function buildTranscript(turns: number): string {
  const out: string[] = []
  for (let i = 0; i < turns; i++) {
    out.push(JSON.stringify({ type: 'user', uuid: `u${i}`, message: { role: 'user', content: `question ${i} — café` } }))
    const content: unknown[] = [
      { type: 'text', text: `answer ${i} ${'x'.repeat(40)}` },
      { type: 'tool_use', id: `t${i}`, name: 'Read', input: { file_path: `/src/file${i}.ts` } },
    ]
    // Every 1000th turn launches a subagent; all but the last one complete.
    if (i % 1000 === 0) content.push({ type: 'tool_use', id: `ag${i}`, name: 'Agent', input: { description: `job ${i}`, subagent_type: 'general' } })
    out.push(JSON.stringify({
      type: 'assistant', uuid: `a${i}`,
      message: { role: 'assistant', model: 'claude-opus-4-5', content, usage: { input_tokens: i + 1 } },
    }))
    const results: unknown[] = [{ type: 'tool_result', tool_use_id: `t${i}`, content: `ok ${i}` }]
    if (i % 1000 === 0 && i !== Math.floor((turns - 1) / 1000) * 1000) results.push({ type: 'tool_result', tool_use_id: `ag${i}`, content: 'done' })
    out.push(JSON.stringify({ type: 'user', uuid: `r${i}`, message: { role: 'user', content: results } }))
    if (i % 97 === 0) out.push('not json at all')
  }
  return out.join('\n') + '\n'
}

function snapshot(session: WatchedSession) {
  return {
    seenToolUseIds: [...session.seenToolUseIds],
    seenMessageHashes: [...session.seenMessageHashes],
    pending: [...session.pendingToolCalls].map(([id, v]) => [id, v.name, v.args, v.filePath]),
    spawned: [...session.spawnedSubagents],
    catchUpSpawns: session.pendingCatchUpSpawns,
    breakdown: session.contextBreakdown,
    model: session.model,
  }
}

function withTranscript(text: string, fn: (file: string, size: number) => Promise<void>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-prescan-'))
  const file = path.join(dir, 's.jsonl')
  fs.writeFileSync(file, text)
  return fn(file, Buffer.byteLength(text)).finally(() => fs.rmSync(dir, { recursive: true, force: true }))
}

describe('prescanExistingContentAsync', () => {
  it('matches the synchronous prescan exactly (entries and session state)', async () => {
    const text = buildTranscript(3500)
    await withTranscript(text, async (file, size) => {
      const syncSession = makeSession()
      const syncEntries = makeParser(syncSession).prescanExistingContent(file, size, syncSession)
      const asyncSession = makeSession()
      const asyncEntries = await makeParser(asyncSession).prescanExistingContentAsync(file, size, asyncSession, { yieldEveryLines: 100 })
      assert.ok(syncEntries.length > 10_000)
      assert.deepEqual(asyncEntries, syncEntries)
      assert.deepEqual(snapshot(asyncSession), snapshot(syncSession))
      assert.ok(asyncSession.pendingCatchUpSpawns.length >= 1, 'last Agent launch is still running')
    })
  })

  it('does not block the event loop for the whole scan', async () => {
    const text = buildTranscript(20_000) // ~60k lines
    await withTranscript(text, async (file, size) => {
      const session = makeSession()
      const parser = makeParser(session)
      let ticks = 0
      let maxGap = 0
      let last = performance.now()
      const timer = setInterval(() => {
        const now = performance.now()
        maxGap = Math.max(maxGap, now - last)
        last = now
        ticks++
      }, 1)
      const t0 = performance.now()
      const entries = await parser.prescanExistingContentAsync(file, size, session, { yieldEveryLines: 500 })
      const total = performance.now() - t0
      clearInterval(timer)
      assert.ok(entries.length >= 40_000)
      assert.ok(ticks >= 5, `timer must fire during the scan (fired ${ticks}x over ${total.toFixed(0)}ms)`)
      assert.ok(maxGap < total * 0.5, `longest event-loop stall ${maxGap.toFixed(0)}ms vs scan ${total.toFixed(0)}ms`)
    })
  })

  it('stops and returns [] when cancelled mid-scan', async () => {
    const text = buildTranscript(2000)
    await withTranscript(text, async (file, size) => {
      const session = makeSession()
      let yields = 0
      const entries = await makeParser(session).prescanExistingContentAsync(file, size, session, {
        yieldEveryLines: 50,
        isCancelled: () => ++yields > 3,
      })
      assert.deepEqual(entries, [])
      assert.ok(session.seenToolUseIds.size < 2000)
    })
  })

  it('ignores bytes appended after `size` (live tail owns those)', async () => {
    const text = buildTranscript(50)
    await withTranscript(text, async (file, size) => {
      fs.appendFileSync(file, JSON.stringify({ type: 'assistant', uuid: 'late', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'late-tool', name: 'Read', input: {} }] } }) + '\n')
      const session = makeSession()
      await makeParser(session).prescanExistingContentAsync(file, size, session)
      assert.ok(!session.seenToolUseIds.has('late-tool'))
    })
  })
})

describe('iterateFileLinesAsync', () => {
  it('yields the same lines as iterateFileLines, across tiny chunk sizes and multibyte text', async () => {
    const text = 'alpha\r\nbéta — \u{1F600}\n\ngamma\ndelta-without-newline'
    await withTranscript(text, async (file, size) => {
      for (const chunk of [1, 3, 7, 64]) {
        const got: string[] = []
        for await (const l of iterateFileLinesAsync(file, size, chunk)) got.push(l)
        assert.deepEqual(got, [...iterateFileLines(file, size, chunk)])
      }
    })
  })
})
