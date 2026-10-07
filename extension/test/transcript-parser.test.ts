/**
 * Unit tests for TranscriptParser's tool_use_id forwarding.
 *
 * The protocol audit (web/hooks/simulation/handle-tool-events.ts) found that
 * tool_call_start/tool_call_end events had no per-call identifier, only
 * agent id + tool name (+ a best-effort args/file-path match). The real id
 * already exists in the transcript — the tool_use block's `id` field (the
 * same id used for tool_use/tool_result pairing in Claude's own protocol) —
 * it just wasn't being forwarded. These tests lock in that it now is.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { TranscriptParser, TranscriptParserDelegate } from '../src/transcript-parser'
import { AgentEvent, PendingToolCall, WatchedSession } from '../src/protocol'

function makeDelegate(): { delegate: TranscriptParserDelegate; events: AgentEvent[] } {
  const events: AgentEvent[] = []
  const delegate: TranscriptParserDelegate = {
    emit: (event) => { events.push(event) },
    elapsed: () => 0,
    getSession: () => undefined as WatchedSession | undefined,
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
  }
  return { delegate, events }
}

describe('TranscriptParser tool_use_id forwarding', () => {
  it('forwards the tool_use block id as tool_use_id on tool_call_start', () => {
    const { delegate, events } = makeDelegate()
    const parser = new TranscriptParser(delegate)
    const pending = new Map<string, PendingToolCall>()
    const seen = new Set<string>()

    const line = JSON.stringify({
      sessionId: 's1',
      type: 'assistant',
      uuid: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_01ABC', input: { command: 'npm test' } }],
      },
    })

    parser.processTranscriptLine(line, 'orchestrator', pending, seen)

    const start = events.find(e => e.type === 'tool_call_start')
    assert.ok(start, 'tool_call_start should have been emitted')
    assert.equal(start!.payload.tool_use_id, 'toolu_01ABC')

    // Also threaded onto the pending-call record used to pair the result.
    assert.equal(pending.get('toolu_01ABC')?.toolUseId, 'toolu_01ABC')
  })

  it('forwards the matching tool_result block tool_use_id as tool_use_id on tool_call_end', () => {
    const { delegate, events } = makeDelegate()
    const parser = new TranscriptParser(delegate)
    const pending = new Map<string, PendingToolCall>()
    const seen = new Set<string>()

    const startLine = JSON.stringify({
      sessionId: 's1',
      type: 'assistant',
      uuid: 'u1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', name: 'Bash', id: 'toolu_01ABC', input: { command: 'npm test' } }],
      },
    })
    const resultLine = JSON.stringify({
      sessionId: 's1',
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'toolu_01ABC', content: 'ok' }],
      },
    })

    parser.processTranscriptLine(startLine, 'orchestrator', pending, seen)
    parser.processTranscriptLine(resultLine, 'orchestrator', pending, seen)

    const end = events.find(e => e.type === 'tool_call_end')
    assert.ok(end, 'tool_call_end should have been emitted')
    assert.equal(end!.payload.tool_use_id, 'toolu_01ABC')
  })

  it('gives two truly-concurrent same-tool-name calls distinct tool_use_ids, enabling exact pairing', () => {
    const { delegate, events } = makeDelegate()
    const parser = new TranscriptParser(delegate)
    const pending = new Map<string, PendingToolCall>()
    const seen = new Set<string>()

    const startLine = JSON.stringify({
      sessionId: 's1',
      type: 'assistant',
      uuid: 'u1',
      message: {
        role: 'assistant',
        content: [
          { type: 'tool_use', name: 'Read', id: 'toolu_A', input: { file_path: 'a.ts' } },
          { type: 'tool_use', name: 'Read', id: 'toolu_B', input: { file_path: 'a.ts' } },
        ],
      },
    })

    parser.processTranscriptLine(startLine, 'orchestrator', pending, seen)

    const starts = events.filter(e => e.type === 'tool_call_start')
    assert.equal(starts.length, 2)
    const ids = starts.map(e => e.payload.tool_use_id).sort()
    assert.deepEqual(ids, ['toolu_A', 'toolu_B'])

    // Results arrive out of order — each must pair with its own call, not
    // whichever same-tool pending entry happens to be seen first.
    const resultLine = JSON.stringify({
      sessionId: 's1',
      type: 'user',
      uuid: 'u2',
      message: {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_B', content: 'b-result' },
          { type: 'tool_result', tool_use_id: 'toolu_A', content: 'a-result' },
        ],
      },
    })
    parser.processTranscriptLine(resultLine, 'orchestrator', pending, seen)

    const ends = events.filter(e => e.type === 'tool_call_end')
    assert.equal(ends.length, 2)
    const byId = new Map(ends.map(e => [e.payload.tool_use_id, e.payload.result]))
    assert.equal(byId.get('toolu_A'), 'a-result')
    assert.equal(byId.get('toolu_B'), 'b-result')
  })
})
