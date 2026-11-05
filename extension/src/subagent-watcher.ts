/**
 * Subagent file watching logic extracted from SessionWatcher.
 *
 * Manages per-session subagent JSONL file discovery, tailing, and event emission.
 *
 * When inline progress events are active for a subagent (tracked via
 * session.inlineProgressAgents), the file watcher still tracks file position
 * but skips event emission to avoid duplicates. This allows seamless fallback
 * to file-based watching on reconnection when inline progress is no longer flowing.
 */

import * as fs from 'fs'
import * as path from 'path'
import { AgentEvent, SubagentState, WatchedSession, emitSubagentSpawn } from './protocol'
import { SESSION_ID_DISPLAY, ORCHESTRATOR_NAME, SUBAGENT_ID_SUFFIX_LENGTH, generateSubagentFallbackName, resolveSubagentChildName } from './constants'
import { readNewFileLines } from './fs-utils'
import { TranscriptParser } from './transcript-parser'
import { handlePermissionDetection, PermissionDetectionDelegate } from './permission-detection'
import { createLogger } from './logger'

const log = createLogger('SubagentWatcher')

/** Minimal transcript-line shape needed to recognise how a subagent's run ends. */
interface TurnEntry {
  type?: string
  toolEndsTurn?: boolean
  message?: { stop_reason?: string | null; content?: unknown }
}

/** Conversation turns; attachment/system/progress lines are bookkeeping, not activity. */
function isTurnEntry(e: TurnEntry): boolean {
  return e.type === 'user' || e.type === 'assistant'
}

/**
 * An entry that ends a subagent's run: a Workflow agent's StructuredOutput
 * result (written with `toolEndsTurn: true`), or an assistant turn that stopped
 * with `end_turn`. Unmatched tool_use blocks are NOT a usable "still running"
 * signal on their own: calls denied by PreToolUse hooks never get a tool_result
 * line, so a finished agent can be left with many of them.
 */
export function isFinishingEntry(e: TurnEntry): boolean {
  return e.toolEndsTurn === true || (e.type === 'assistant' && e.message?.stop_reason === 'end_turn')
}

/** At attach time, a transcript untouched this long is treated as finished even
 *  without a finishing entry (killed/crashed runs). */
export const STALE_SUBAGENT_MS = 10 * 60 * 1000

function parseTurnEntries(lines: readonly string[]): TurnEntry[] {
  const out: TurnEntry[] = []
  for (const line of lines) {
    try {
      const e = JSON.parse(line) as TurnEntry
      if (e && typeof e === 'object' && isTurnEntry(e)) out.push(e)
    } catch { /* partial or non-JSON line */ }
  }
  return out
}

/** Mark a subagent finished: emit return + complete, and drop its pending tool
 *  calls so permission detection stops treating hook-denied calls as waiting. */
function markSubagentFinished(delegate: SubagentWatcherDelegate, state: SubagentState, sessionId: string): void {
  state.completed = true
  state.pendingToolCalls.clear()
  if (state.permissionTimer) { clearTimeout(state.permissionTimer); state.permissionTimer = null }
  state.permissionEmitted = false
  delegate.emit({
    time: delegate.elapsed(sessionId),
    type: 'subagent_return',
    payload: { child: state.agentName, parent: ORCHESTRATOR_NAME, summary: '' },
  }, sessionId)
  delegate.emit({
    time: delegate.elapsed(sessionId),
    type: 'agent_complete',
    payload: { name: state.agentName },
  }, sessionId)
}

export interface SubagentWatcherDelegate extends PermissionDetectionDelegate {
  getSession(sessionId: string): WatchedSession | undefined
  resetInactivityTimer(sessionId: string): void
}

/**
 * Read the .meta.json sidecar file to resolve the subagent's name.
 * Falls back to generateSubagentFallbackName if the meta file is missing or unreadable.
 *
 * For agents that carry no descriptive name in their meta (e.g. Workflow
 * subagents, whose meta is just `{"agentType":"workflow-subagent"}`), we derive
 * a stable name from the transcript file's own id (agent-<hash>.jsonl) so each
 * one renders as a distinct node instead of colliding on a generic label.
 */
function resolveNameFromMeta(jsonlPath: string, fallbackIndex: number): string {
  const metaPath = jsonlPath.replace(/\.jsonl$/, '.meta.json')
  // Stable id from the filename, e.g. "agent-a0fb14872db487d5b" → "a0fb14872db487d5b"
  const fileId = path.basename(jsonlPath, '.jsonl')
  const agentId = fileId.replace(/^agent-/, '')
  try {
    const raw = fs.readFileSync(metaPath, 'utf-8')
    const meta = JSON.parse(raw) as Record<string, unknown>
    const name = resolveSubagentChildName(meta)
    if (name && name !== 'subagent') return name
    // No descriptive name (e.g. Workflow subagents: {"agentType":"workflow-subagent"}).
    // Use the same `<agentType>-<id suffix>` convention as the SubagentStop hook
    // (hook-server.ts) so hook-emitted completion events resolve to this node.
    if (typeof meta.agentType === 'string' && meta.agentType) {
      return `${meta.agentType}-${agentId.slice(-SUBAGENT_ID_SUFFIX_LENGTH)}`
    }
  } catch { /* meta file may not exist for older Claude Code versions */ }
  return generateSubagentFallbackName(agentId, fallbackIndex)
}

/** Recursively collect every agent-*.jsonl transcript under a subagents directory.
 *  Newer Claude Code nests Workflow subagents under
 *  `subagents/workflows/wf_<id>/agent-*.jsonl`, so a flat readdir misses them.
 *  Other .jsonl files in the tree (e.g. the workflow `journal.jsonl`) are not
 *  agent transcripts and would otherwise render as bogus subagent nodes. */
export function collectSubagentJsonlFiles(dir: string): string[] {
  const found: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return found }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...collectSubagentJsonlFiles(full))
    } else if (entry.isFile() && entry.name.startsWith('agent-') && entry.name.endsWith('.jsonl')) {
      found.push(full)
    }
  }
  return found
}

/** Newest mtime (ms) across every *.jsonl under a subagents directory, recursively.
 *  Used for session-liveness checks: a session whose main transcript is stale may
 *  still be running Workflow subagents that only write under
 *  `subagents/workflows/wf_<id>/`. Deliberately includes non-agent files like the
 *  workflow `journal.jsonl` — during a run it is often the most recently written
 *  file, and any write under the tree means the session is alive.
 *  Returns 0 if the directory is missing or has no .jsonl files. */
export function newestSubagentMtime(dir: string): number {
  let newest = 0
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch { return newest }
  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      const sub = newestSubagentMtime(full)
      if (sub > newest) newest = sub
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      try {
        const mt = fs.statSync(full).mtimeMs
        if (mt > newest) newest = mt
      } catch { /* file may vanish mid-scan */ }
    }
  }
  return newest
}

/** Scan the subagents directory for new JSONL files and start tailing them */
export function scanSubagentsDir(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session || !session.subagentsDir) return

  // Start watching the directory tree once it exists. Try a recursive watch
  // first (supported on Windows/macOS) so nested workflow subagent files are
  // detected promptly; fall back to a flat watch on platforms without recursive
  // support (Linux). Either way the POLL_FALLBACK_MS poll re-scans recursively.
  if (!session.subagentsDirWatcher && fs.existsSync(session.subagentsDir)) {
    const onChange = () => scanSubagentsDir(delegate, parser, sessionId)
    try {
      session.subagentsDirWatcher = fs.watch(session.subagentsDir, { recursive: true }, onChange)
    } catch {
      try {
        session.subagentsDirWatcher = fs.watch(session.subagentsDir, onChange)
      } catch (err) { log.debug('Subagent dir watch failed:', err) }
    }
  }

  const subDir = session.subagentsDir
  if (!fs.existsSync(subDir)) return

  try {
    // Recurse — Workflow subagents live under subagents/workflows/wf_<id>/.
    for (const filePath of collectSubagentJsonlFiles(subDir)) {
      if (session.subagentWatchers.has(filePath)) continue
      startWatchingSubagentFile(delegate, parser, filePath, sessionId)
    }
  } catch (err) { log.debug('Subagent dir scan failed:', err) }
}

/**
 * Watch agent transcripts in subagent folders other than `session.subagentsDir`.
 * Older Claude Code versions kept a session's transcript in place after it
 * entered a worktree but wrote its subagents under the worktree's project folder.
 */
export function scanExtraSubagentDirs(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
  dirs: readonly string[],
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  for (const dir of dirs) {
    for (const filePath of collectSubagentJsonlFiles(dir)) {
      if (session.subagentWatchers.has(filePath)) continue
      startWatchingSubagentFile(delegate, parser, filePath, sessionId)
    }
  }
}

/**
 * Re-key subagent watchers after their folder moved from `fromDir` to `toDir`,
 * keeping each one's read offset so nothing is skipped or replayed.
 */
export function moveSubagentWatchers(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  sessionId: string,
  fromDir: string,
  toDir: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  for (const [oldPath, state] of [...session.subagentWatchers]) {
    const rel = path.relative(fromDir, oldPath)
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue
    const newPath = path.join(toDir, rel)
    state.watcher?.close()
    state.watcher = null
    session.subagentWatchers.delete(oldPath)
    // Already picked up at its new path by a scan that ran mid-move
    if (session.subagentWatchers.has(newPath)) continue
    session.subagentWatchers.set(newPath, state)
    try {
      state.watcher = fs.watch(newPath, () => {
        readSubagentNewLines(delegate, parser, newPath, sessionId)
      })
    } catch (err) { log.debug('Subagent file watch failed:', err) }
  }
}

function startWatchingSubagentFile(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return

  // Resolve name from the meta file (deterministic, no queue race)
  const agentName = resolveNameFromMeta(filePath, session.subagentWatchers.size + 1)
  log.info(`Tailing subagent: ${path.basename(filePath)} as "${agentName}" (session ${sessionId.slice(0, SESSION_ID_DISPLAY)})`)

  const state: SubagentState = {
    watcher: null,
    fileSize: 0,
    fileTail: '',
    agentName,
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    permissionTimer: null,
    permissionEmitted: false,
    spawnEmitted: false,
    completed: false,
  }
  session.subagentWatchers.set(filePath, state)

  // Pre-scan existing content for dedup IDs and determine if the subagent
  // is still active (has unmatched tool_use blocks = pending work).
  const pendingToolUseIds = new Set<string>()
  let lastTurn: TurnEntry | null = null
  let stale = false
  try {
    const stat = fs.statSync(filePath)
    stale = Date.now() - stat.mtimeMs > STALE_SUBAGENT_MS
    if (stat.size > 0) {
      const content = fs.readFileSync(filePath, 'utf-8')
      for (const line of content.split(/\r?\n/)) {
        if (!line.trim()) continue
        try {
          const raw: unknown = JSON.parse(line.trim())
          if (raw && typeof raw === 'object' && isTurnEntry(raw as TurnEntry)) lastTurn = raw as TurnEntry
          const entry = raw as { message?: { content?: Array<{ type: string; id?: string; tool_use_id?: string }> } }
          if (raw && typeof raw === 'object' && entry.message && Array.isArray(entry.message.content)) {
            for (const block of entry.message.content) {
              if (block.type === 'tool_use' && block.id) {
                state.seenToolUseIds.add(block.id)
                pendingToolUseIds.add(block.id)
              } else if (block.type === 'tool_result' && block.tool_use_id) {
                pendingToolUseIds.delete(block.tool_use_id)
              }
            }
          }
        } catch { /* skip unparseable subagent transcript lines */ }
      }
      state.fileSize = stat.size
    }
  } catch (err) { log.debug('Subagent initial read failed:', err) }

  // Already finished at attach time: never show it as running. Marked completed
  // (and spawn-emitted) so that if it is written again later, the resume path
  // in readSubagentNewLines re-spawns it.
  if ((lastTurn && isFinishingEntry(lastTurn)) || (stale && pendingToolUseIds.size > 0)) {
    state.spawnEmitted = true
    state.completed = true
  } else {
    // Only emit spawn for subagents that are still active (have pending work)
    // AND haven't already been spawned by the transcript parser.
    const alreadySpawned = session.spawnedSubagents.has(agentName)
  state.spawnEmitted = pendingToolUseIds.size > 0 || alreadySpawned
    if (pendingToolUseIds.size > 0 && !alreadySpawned) {
      session.spawnedSubagents.add(agentName)
      emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, agentName, agentName, sessionId)
    }
  }

  // Watch for new content
  try {
    state.watcher = fs.watch(filePath, () => {
      readSubagentNewLines(delegate, parser, filePath, sessionId)
    })
  } catch (err) { log.debug('Subagent file watch failed:', err) }
}

export function readSubagentNewLines(
  delegate: SubagentWatcherDelegate,
  parser: TranscriptParser,
  filePath: string,
  sessionId: string,
): void {
  const session = delegate.getSession(sessionId)
  if (!session) return
  const state = session.subagentWatchers.get(filePath)
  if (!state) return

  const result = readNewFileLines(filePath, state.fileSize, state.fileTail)
  if (!result) return
  state.fileSize = result.newSize
  state.fileTail = result.tail

  // If inline progress events are handling this subagent, skip event emission
  // from the file watcher to avoid duplicates. We still advance fileSize above
  // so that if inline progress stops (e.g. reconnection), we resume from the
  // correct position without re-emitting old events.
  if (session.inlineProgressAgents.has(state.agentName)) {
    // Still keep the session alive — the subagent is working
    delegate.resetInactivityTimer(sessionId)
    return
  }

  // Lazily emit spawn on first new content if not already emitted
  if (!state.spawnEmitted) {
    state.spawnEmitted = true
    if (!session.spawnedSubagents.has(state.agentName)) {
      session.spawnedSubagents.add(state.agentName)
      emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, state.agentName, state.agentName, sessionId)
    }
  }

  const turns = parseTurnEntries(result.lines)

  // Node was completed (finishing entry, its Workflow/Task result, or found
  // finished at attach time) but the transcript is being written again: a
  // resumed run. Revive it, mirroring how the orchestrator node is resurrected
  // in resetInactivityTimer. Bookkeeping lines (attachments) or a late-arriving
  // finishing entry alone are not a resume.
  if (state.completed) {
    if (!turns.some(t => !isFinishingEntry(t))) {
      delegate.resetInactivityTimer(sessionId)
      return
    }
    state.completed = false
    emitSubagentSpawn(delegate, ORCHESTRATOR_NAME, state.agentName, state.agentName, sessionId, true)
  }

  for (const line of result.lines) {
    parser.processTranscriptLine(line, state.agentName, state.pendingToolCalls, state.seenToolUseIds, sessionId)
  }

  // The run ended in this batch: complete the node now instead of waiting for a
  // Workflow/Task result that may never match (see isFinishingEntry).
  const lastTurn = turns[turns.length - 1]
  if (lastTurn && isFinishingEntry(lastTurn)) {
    markSubagentFinished(delegate, state, sessionId)
    delegate.resetInactivityTimer(sessionId)
    return
  }

  // Permission detection for subagent tools
  handlePermissionDetection(delegate, state.agentName, state.pendingToolCalls, state, sessionId)

  // Keep main session alive while subagents are working
  delegate.resetInactivityTimer(sessionId)
}
