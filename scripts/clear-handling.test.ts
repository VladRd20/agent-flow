import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  isConversationLine, isClearCommandLine, classifyTranscriptLines,
} from '../extension/src/transcript-activity'
import { cleanLabelText } from '../extension/src/session-label'
import { TranscriptParser } from '../extension/src/transcript-parser'
import { pruneStaleDiscoveryFiles } from './discovery-prune'
import type { WatchedSession } from '../extension/src/protocol'

const j = (o: unknown) => JSON.stringify(o)

describe('transcript-activity', () => {
  it('bookkeeping lines are not conversation', () => {
    for (const type of ['queue-operation', 'cost-state', 'bridge-session', 'custom-title', 'agent-name',
      'file-history-snapshot', 'artifact-comment-monitor', 'api-request-shape', 'system', 'attachment']) {
      assert.equal(isConversationLine(j({ type, operation: 'dequeue' })), false, type)
    }
  })
  it('isMeta user lines are not conversation; real user/assistant/progress are', () => {
    assert.equal(isConversationLine(j({ type: 'user', isMeta: true, message: { role: 'user', content: 'x' } })), false)
    assert.equal(isConversationLine(j({ type: 'user', message: { role: 'user', content: 'x' } })), true)
    assert.equal(isConversationLine(j({ type: 'assistant', message: { role: 'assistant', content: [] } })), true)
    assert.equal(isConversationLine(j({ type: 'progress', data: {} })), true)
    assert.equal(isConversationLine('not json'), false)
    assert.equal(isConversationLine(''), false)
  })
  it('only an exact /clear enqueue is a clear command', () => {
    assert.equal(isClearCommandLine(j({ type: 'queue-operation', operation: 'enqueue', content: '/clear' })), true)
    assert.equal(isClearCommandLine(j({ type: 'queue-operation', operation: 'enqueue', content: ' /clear\n' })), true)
    assert.equal(isClearCommandLine(j({ type: 'queue-operation', operation: 'dequeue', content: '/clear' })), false)
    assert.equal(isClearCommandLine(j({ type: 'queue-operation', operation: 'enqueue', content: '/compact' })), false)
    assert.equal(isClearCommandLine(j({ type: 'queue-operation', operation: 'enqueue', content: '/clear now' })), false)
    assert.equal(isClearCommandLine(j({ type: 'user', content: '/clear' })), false)
  })
  it('classifies batches in order (resume revives, clear ends)', () => {
    const clear = j({ type: 'queue-operation', operation: 'enqueue', content: '/clear' })
    const book = j({ type: 'cost-state' })
    const user = j({ type: 'user', message: { role: 'user', content: 'hi' } })
    assert.deepEqual(classifyTranscriptLines([clear, book]), { conversation: false, ended: true })
    assert.deepEqual(classifyTranscriptLines([book]), { conversation: false, ended: false })
    assert.deepEqual(classifyTranscriptLines([clear, user]), { conversation: true, ended: false })
    assert.deepEqual(classifyTranscriptLines([user, clear]), { conversation: false, ended: true })
  })
})

describe('cleanLabelText', () => {
  it('strips quoted and bare leading mentions', () => {
    assert.equal(cleanLabelText('@"C:\\Users\\A B\\file.mp4" Agent Flow, this is'), 'Agent Flow, this is')
    assert.equal(cleanLabelText('  @src/a.ts @"x y.txt"   fix it'), 'fix it')
    assert.equal(cleanLabelText('hello @world'), 'hello @world')
  })
  it('falls back to the mentioned file basename', () => {
    assert.equal(cleanLabelText('@"C:\\Users\\A B\\file.mp4"'), 'file.mp4')
    assert.equal(cleanLabelText('@src/dir/a.ts'), 'a.ts')
  })
})

describe('label flow', () => {
  function setup() {
    const session = { label: 'Session 44a23573', labelSet: false, contextBreakdown: { userMessages: 0 } } as unknown as WatchedSession
    const fired: string[] = []
    const parser = new TranscriptParser({
      emit: () => {}, elapsed: () => 0,
      getSession: () => session,
      fireSessionLifecycle: (e) => fired.push(`${e.type}:${e.label}`),
      emitContextUpdate: () => {}, scanSubagents: () => {},
    } as never)
    const feed = (o: unknown) => parser.processTranscriptLine(j(o), 'orchestrator', new Map(), new Set(), 's1', new Set())
    return { session, fired, feed, parser }
  }
  it('custom-title is a fallback and a real prompt replaces it', () => {
    const { session, fired, feed } = setup()
    feed({ type: 'custom-title', customTitle: 'General' })
    assert.equal(session.label, 'General')
    assert.equal(session.labelSet, false)
    feed({ type: 'user', message: { role: 'user', content: '<command-name>/clear</command-name>' } })
    assert.equal(session.label, 'General')
    feed({ type: 'user', message: { role: 'user', content: '@"C:\\a\\b.mp4" Agent Flow, go' } })
    assert.equal(session.label, 'Agent Flow, go')
    assert.equal(session.labelSet, true)
    assert.deepEqual(fired, ['updated:General', 'updated:Agent Flow, go'])
    feed({ type: 'custom-title', customTitle: 'Other' })
    assert.equal(session.label, 'Agent Flow, go')
  })
  it('extractSessionLabel cleans mentions and honours customTitle', () => {
    const { session, parser } = setup()
    session.customTitle = 'General'
    parser.extractSessionLabel([], session)
    assert.equal(session.label, 'General')
    assert.equal(session.labelSet, false)
    parser.extractSessionLabel([{ sessionId: 's', type: 'user', message: { role: 'user', content: '@"C:\\x\\clip.mp4"' } }], session)
    assert.equal(session.label, 'clip.mp4')
    assert.equal(session.labelSet, true)
  })
})

describe('pruneStaleDiscoveryFiles', () => {
  it('removes only dead-pid discovery json files', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-prune-'))
    try {
      const w = (n: string, body: string) => fs.writeFileSync(path.join(dir, n), body)
      w('aaa-111.json', j({ port: 1, pid: 111, workspace: 'x' }))
      w('bbb-222.json', j({ port: 2, pid: 222, workspace: 'x' }))
      w('own-333.json', j({ port: 3, pid: 333, workspace: 'x' }))
      w('workspaces.json', j({ pid: 111 }))
      w('broken.json', '{nope')
      w('nopid.json', j({ port: 5 }))
      w('notes.txt', 'keep')
      const removed = pruneStaleDiscoveryFiles(dir, path.join(dir, 'own-333.json'), (pid) => pid === 222)
      assert.deepEqual(removed, ['aaa-111.json'])
      assert.deepEqual(fs.readdirSync(dir).sort(),
        ['bbb-222.json', 'broken.json', 'nopid.json', 'notes.txt', 'own-333.json', 'workspaces.json'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('real pid check: dead pid pruned, own pid kept', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-prune-'))
    try {
      fs.writeFileSync(path.join(dir, 'a-2147480000.json'), j({ pid: 2147480000 }))
      fs.writeFileSync(path.join(dir, `b-${process.pid}.json`), j({ pid: process.pid }))
      assert.deepEqual(pruneStaleDiscoveryFiles(dir, null), ['a-2147480000.json'])
    } finally { fs.rmSync(dir, { recursive: true, force: true }) }
  })
  it('missing dir is a no-op', () => {
    assert.deepEqual(pruneStaleDiscoveryFiles(path.join(os.tmpdir(), 'af-does-not-exist-xyz'), null), [])
  })
})
