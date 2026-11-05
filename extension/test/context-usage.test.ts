/**
 * Context-window accounting: authoritative usage from assistant transcript
 * lines, rescaled breakdown, compaction reset, and prescan catch-up.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { TranscriptParser, TranscriptParserDelegate } from '../src/transcript-parser'
import { AgentEvent, WatchedSession } from '../src/protocol'
import { buildContextPayload, contextTokensFromUsage } from '../src/context-usage'

const SID = 's1'

function makeSession(): WatchedSession {
  return {
    sessionId: SID, filePath: '/tmp/s1.jsonl', fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(), pendingToolCalls: new Map(), seenToolUseIds: new Set(), seenMessageHashes: new Set(),
    sessionDetected: true, sessionCompleted: false, lastActivityTime: Date.now(), inactivityTimer: null,
    subagentWatchers: new Map(), spawnedSubagents: new Set(), inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null, label: 'S', labelSet: true, model: null,
    modelDetectedAgents: new Map(), permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: 100, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    pendingCatchUpSpawns: [],
  }
}

function setup() {
  const session = makeSession()
  const events: AgentEvent[] = []
  const delegate: TranscriptParserDelegate = {
    emit: (e) => { events.push(e) },
    elapsed: () => 0,
    getSession: (id) => (id === SID ? session : undefined),
    fireSessionLifecycle: () => {},
    emitContextUpdate: (agent, s) => { events.push({ time: 0, type: 'context_update', payload: { agent, ...buildContextPayload(s, agent) } }) },
  }
  const parser = new TranscriptParser(delegate)
  const feed = (entry: unknown, agent = 'orchestrator') => parser.processTranscriptLine(
    JSON.stringify(entry), agent, session.pendingToolCalls, session.seenToolUseIds, SID, session.seenMessageHashes,
  )
  return { session, events, parser, feed }
}

const assistant = (uuid: string, text: string, usage?: unknown) => ({
  type: 'assistant', uuid,
  message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'text', text }], ...(usage ? { usage } : {}) },
})
const lastCtx = (events: AgentEvent[], agent: string) =>
  events.filter(e => e.type === 'context_update' && e.payload.agent === agent).pop()!.payload as Record<string, any>
const sum = (b: Record<string, number>) => Object.values(b).reduce((a, c) => a + c, 0)

describe('contextTokensFromUsage', () => {
  it('sums input, cache creation, cache read and output', () => {
    assert.equal(contextTokensFromUsage({ input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 }), 116)
  })
  it('returns undefined for missing or zero usage', () => {
    assert.equal(contextTokensFromUsage(undefined), undefined)
    assert.equal(contextTokensFromUsage({ input_tokens: 0, output_tokens: 0 }), undefined)
  })
})

describe('context_update tokens', () => {
  it('uses the latest usage, not the cumulative estimate', () => {
    const { events, feed } = setup()
    for (let i = 0; i < 5; i++) {
      feed(assistant(`a${i}`, 'x'.repeat(4000), { input_tokens: 10, cache_read_input_tokens: 1000 * (i + 1), output_tokens: 0 }))
    }
    const p = lastCtx(events, 'orchestrator')
    assert.equal(p.tokens, 5010)
    assert.equal(p.isAuthoritative, true)
    assert.equal(sum(p.breakdown), 5010)
    assert.ok(p.breakdown.reasoning > 0)
  })

  it('falls back to the estimate before any usage is seen', () => {
    const { events, feed } = setup()
    feed(assistant('a1', 'x'.repeat(400)))
    const p = lastCtx(events, 'orchestrator')
    assert.equal(p.isAuthoritative, undefined)
    assert.ok(p.tokens >= 100)
  })

  it('tracks subagents separately', () => {
    const { events, feed } = setup()
    feed(assistant('m1', 'main', { input_tokens: 5000 }))
    feed(assistant('s1', 'sub', { input_tokens: 300 }), 'Explorer')
    assert.equal(lastCtx(events, 'orchestrator').tokens, 5000)
    assert.equal(lastCtx(events, 'Explorer').tokens, 300)
  })

  it('resets estimates and usage on compact_boundary', () => {
    const { session, events, feed } = setup()
    feed(assistant('a1', 'x'.repeat(4000), { input_tokens: 900_000 }))
    feed({ type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 900_000 } })
    const p = lastCtx(events, 'orchestrator')
    assert.equal(p.isAuthoritative, undefined)
    assert.equal(p.tokens, 100)
    assert.equal(session.contextBreakdown.reasoning, 0)
    feed(assistant('a2', 'short', { input_tokens: 20_000 }))
    assert.equal(lastCtx(events, 'orchestrator').tokens, 20_000)
  })

  it('ends prescan with the latest usage, and honours a compaction in history', () => {
    const { session, parser } = setup()
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-flow-ctx-'))
    const file = path.join(dir, 's.jsonl')
    const lines = [
      assistant('a1', 'x'.repeat(8000), { input_tokens: 800_000 }),
      { type: 'system', subtype: 'compact_boundary', compactMetadata: { preTokens: 800_000 } },
      assistant('a2', 'y'.repeat(400), { input_tokens: 10, cache_creation_input_tokens: 40, cache_read_input_tokens: 25_000 }),
      assistant('a3', 'z'.repeat(400), { input_tokens: 10, cache_read_input_tokens: 26_000 }),
    ].map(e => JSON.stringify(e)).join('\n') + '\n'
    fs.writeFileSync(file, lines)
    parser.prescanExistingContent(file, Buffer.byteLength(lines), session)
    const p = buildContextPayload(session, 'orchestrator')
    assert.equal(p.tokens, 26_010)
    assert.equal(sum(p.breakdown), 26_010)
    // the pre-compaction 8000-char message no longer inflates the reasoning share
    assert.ok(session.contextBreakdown.reasoning < 500)
  })
})
