/**
 * Subagents are completed from their own transcript (StructuredOutput result
 * with toolEndsTurn, or an assistant end_turn), not from "no unmatched
 * tool_use left": calls denied by PreToolUse hooks never get a tool_result, so
 * finished agents can carry many unmatched tool_use blocks.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readSubagentNewLines, scanSubagentsDir, isFinishingEntry } from '../src/subagent-watcher'
import { TranscriptParser } from '../src/transcript-parser'
import type { AgentEvent, WatchedSession } from '../src/protocol'

const SID = 's1'

const toolUse = (id: string) => JSON.stringify({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: 'ls' } }] } })
const toolResult = (id: string, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', ...extra, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } })
const structuredDone = (id: string) => toolResult(id, { toolEndsTurn: true })
const attachment = () => JSON.stringify({ type: 'attachment', attachment: { type: 'x' } })
const userText = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } })

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'af-finish-'))
  const subDir = path.join(root, 'subagents')
  fs.mkdirSync(subDir)
  const session = {
    sessionId: SID, subagentWatchers: new Map(), subagentsDir: subDir,
    spawnedSubagents: new Set<string>(), inlineProgressAgents: new Set(),
    seenMessageHashes: new Set(), pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    modelDetectedAgents: new Map(), pendingCatchUpSpawns: [],
  } as unknown as WatchedSession
  const events: AgentEvent[] = []
  const delegate = {
    emit: (e: AgentEvent) => { events.push(e) },
    elapsed: () => 0,
    getSession: () => session,
    resetInactivityTimer: () => {},
    fireSessionLifecycle: () => {},
    emitContextUpdate: () => {},
    scanSubagents: () => {},
  }
  const parser = new TranscriptParser(delegate as never)
  const write = (name: string, lines: string[]) => {
    const file = path.join(subDir, `agent-${name}.jsonl`)
    fs.writeFileSync(file, lines.join('\n') + '\n')
    fs.writeFileSync(file.replace(/\.jsonl$/, '.meta.json'), JSON.stringify({ agentType: 'workflow-subagent', description: name }))
    return file
  }
  const cleanup = () => {
    for (const s of session.subagentWatchers.values()) s.watcher?.close()
    session.subagentsDirWatcher?.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
  return { session, events, delegate, parser, write, cleanup }
}

const types = (events: AgentEvent[], name: string) =>
  events.filter(e => (e.payload as Record<string, unknown>).name === name).map(e => e.type)

describe('subagent finishing', () => {
  it('recognises finishing entries', () => {
    assert.ok(isFinishingEntry({ type: 'user', toolEndsTurn: true }))
    assert.ok(isFinishingEntry({ type: 'assistant', message: { stop_reason: 'end_turn' } }))
    assert.ok(!isFinishingEntry({ type: 'assistant', message: { stop_reason: 'tool_use' } }))
    assert.ok(!isFinishingEntry({ type: 'user' }))
  })

  it('does not spawn an agent that already finished, even with hook-denied (unmatched) tool calls', () => {
    const t = setup()
    try {
      t.write('find-web-ui', [toolUse('a'), toolUse('denied1'), toolResult('a'), toolUse('denied2'), structuredDone('so')])
      scanSubagentsDir(t.delegate as never, t.parser, SID)
      assert.deepEqual(types(t.events, 'find-web-ui'), [])
      const state = [...t.session.subagentWatchers.values()][0]
      assert.equal(state.completed, true)
    } finally { t.cleanup() }
  })

  it('still spawns an agent that is mid-run at attach time', () => {
    const t = setup()
    try {
      t.write('fix-web', [toolUse('a'), toolResult('a'), toolUse('b')])
      scanSubagentsDir(t.delegate as never, t.parser, SID)
      assert.deepEqual(types(t.events, 'fix-web'), ['agent_spawn'])
    } finally { t.cleanup() }
  })

  it('completes a live agent when its finishing entry arrives, and stops permission tracking', () => {
    const t = setup()
    try {
      const file = t.write('gate', [toolUse('a')])
      scanSubagentsDir(t.delegate as never, t.parser, SID)
      fs.appendFileSync(file, [toolUse('denied'), toolResult('a'), structuredDone('so')].join('\n') + '\n')
      readSubagentNewLines(t.delegate as never, t.parser, file, SID)
      assert.ok(types(t.events, 'gate').includes('agent_complete'))
      const state = t.session.subagentWatchers.get(file)!
      assert.equal(state.completed, true)
      assert.equal(state.pendingToolCalls.size, 0)
    } finally { t.cleanup() }
  })

  it('bookkeeping lines after completion do not revive it; a new user turn does', () => {
    const t = setup()
    try {
      const file = t.write('worker', [toolUse('a'), toolResult('a'), structuredDone('so')])
      scanSubagentsDir(t.delegate as never, t.parser, SID)
      fs.appendFileSync(file, attachment() + '\n')
      readSubagentNewLines(t.delegate as never, t.parser, file, SID)
      assert.deepEqual(types(t.events, 'worker'), [])
      fs.appendFileSync(file, userText('one more thing') + '\n')
      readSubagentNewLines(t.delegate as never, t.parser, file, SID)
      const spawn = t.events.find(e => e.type === 'agent_spawn' && (e.payload as Record<string, unknown>).name === 'worker')
      assert.ok(spawn, 'revived')
      assert.equal((spawn!.payload as Record<string, unknown>).resumed, true)
    } finally { t.cleanup() }
  })
})
