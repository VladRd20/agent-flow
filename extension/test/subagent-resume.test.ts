/**
 * A subagent whose transcript is written again after it completed re-emits
 * agent_spawn flagged `resumed: true`, so the webview can tell a real resume
 * from a brand-new agent that merely reuses a finished one's name.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { readSubagentNewLines } from '../src/subagent-watcher'
import { TranscriptParser } from '../src/transcript-parser'
import { emitSubagentSpawn, AgentEvent, SubagentState, WatchedSession } from '../src/protocol'

const SID = 's1'

function setup(completed: boolean) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-resume-'))
  const file = path.join(dir, 'agent-x.jsonl')
  fs.writeFileSync(file, JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] } }) + '\n')
  const state = {
    watcher: null, fileSize: 0, fileTail: '', agentName: 'worker',
    pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    permissionTimer: null, permissionEmitted: false, spawnEmitted: true, completed,
  } as SubagentState
  const session = {
    sessionId: SID, subagentWatchers: new Map([[file, state]]),
    spawnedSubagents: new Set(['worker']), inlineProgressAgents: new Set(),
    seenMessageHashes: new Set(), pendingToolCalls: new Map(), seenToolUseIds: new Set(),
    contextBreakdown: { systemPrompt: 0, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
    modelDetectedAgents: new Map(),
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
  return { dir, file, state, delegate, parser, events }
}

describe('subagent resume marking', () => {
  it('flags the re-emitted agent_spawn as resumed when the watcher was completed', () => {
    const t = setup(true)
    try {
      readSubagentNewLines(t.delegate as never, t.parser, t.file, SID)
      const spawns = t.events.filter(e => e.type === 'agent_spawn')
      assert.equal(spawns.length, 1)
      assert.equal((spawns[0].payload as Record<string, unknown>).resumed, true)
      assert.equal(t.state.completed, false)
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }) }
  })

  it('does not emit a spawn for a never-completed watcher', () => {
    const t = setup(false)
    try {
      readSubagentNewLines(t.delegate as never, t.parser, t.file, SID)
      assert.equal(t.events.filter(e => e.type === 'agent_spawn').length, 0)
    } finally { fs.rmSync(t.dir, { recursive: true, force: true }) }
  })

  it('emitSubagentSpawn omits resumed by default', () => {
    const events: AgentEvent[] = []
    emitSubagentSpawn({ emit: e => { events.push(e) }, elapsed: () => 0 }, 'Orchestrator', 'a', 'task', SID)
    const spawn = events.find(e => e.type === 'agent_spawn')!
    assert.ok(!('resumed' in (spawn.payload as object)))
  })
})
