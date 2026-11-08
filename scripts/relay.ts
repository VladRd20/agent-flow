/**
 * Shared relay module — receives agent events and streams them to SSE clients.
 * Used by both the dev relay server and the standalone app.
 */
import * as http from 'http'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { HookServer } from '../extension/src/hook-server'
import { AgentEvent, SessionInfo, WatchedSession } from '../extension/src/protocol'
import { SeqAssigner, resolveSince, firstIndexAfter, trimEventBuffer } from './relay-seq'
import { buildContextPayload } from '../extension/src/context-usage'
import { TranscriptParser } from '../extension/src/transcript-parser'
import { readNewFileLines, foldPathCase } from '../extension/src/fs-utils'
import { scanSubagentsDir, readSubagentNewLines, newestSubagentMtime } from '../extension/src/subagent-watcher'
import { followSession } from '../extension/src/session-relocation'
import { handlePermissionDetection } from '../extension/src/permission-detection'
import { CodexSessionWatcher } from '../extension/src/codex-session-watcher'
import { filterHookEventForWatchedSession } from '../extension/src/subagent-event-filter'
import {
  INACTIVITY_TIMEOUT_MS, ACTIVE_SESSION_AGE_S, POLL_FALLBACK_MS,
  SESSION_ID_DISPLAY, SYSTEM_PROMPT_BASE_TOKENS, ORCHESTRATOR_NAME,
  HOOK_SERVER_NOT_STARTED, WORKSPACE_HASH_LENGTH,
  SESSION_RETENTION_MS, SESSION_PRUNE_INTERVAL_MS, deriveAgentType,
} from '../extension/src/constants'
import { setLogLevel } from '../extension/src/logger'
import type { TelemetryClient } from './telemetry'

const MAX_EVENT_BUFFER = 50000
const MAX_BUFFERED_SESSIONS = 200
const SSE_HEARTBEAT_MS = 25_000
/** Drop SSE clients whose socket write buffer exceeds this (stalled/slow consumers). */
const SSE_MAX_WRITABLE_BYTES = 4 * 1024 * 1024
/** Events per replay message, and how long a replaying client may stay blocked on a full socket. */
const REPLAY_CHUNK_EVENTS = 500
const REPLAY_DRAIN_TIMEOUT_MS = 30_000
/** Random per-process id: seq numbers are only comparable within one epoch. */
const BOOT_ID = crypto.randomUUID()
const seqAssigner = new SeqAssigner()
/** Session scan cadence; the project-dir watcher already triggers scans on new files. */
const RELAY_SCAN_INTERVAL_MS = 5000
/** Coalesce the several fs.watch change events Windows fires per write. */
const WATCH_DEBOUNCE_MS = 75
const DISCOVERY_DIR = path.join(os.homedir(), '.claude', 'agent-flow')
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects')

let relayCreated = false
let verbose = false
let sessionEventCount = 0
/** Distinct model IDs seen across all watched sessions during this relay session.
 *  Populated from `model_detected` events (emitted by both the Claude transcript
 *  parser and the Codex rollout parser). Read at session_end for telemetry. */
const observedModels = new Set<string>()

// agent-flow-app version. Inlined by esbuild at bundle time via `define`.
// In dev (running from source via tsx), falls back to reading app/package.json.
declare const AGENT_FLOW_APP_VERSION: string | undefined
function resolveAgentFlowVersion(): string {
  try {
    if (typeof AGENT_FLOW_APP_VERSION === 'string' && AGENT_FLOW_APP_VERSION) {
      return AGENT_FLOW_APP_VERSION
    }
  } catch { /* ReferenceError in unbundled dev — fall through */ }
  try {
    const pkgPath = path.join(__dirname, '..', 'app', 'package.json')
    if (fs.existsSync(pkgPath)) {
      return JSON.parse(fs.readFileSync(pkgPath, 'utf-8')).version ?? '0.0.0'
    }
  } catch { /* ignore */ }
  return '0.0.0'
}

function log(...args: unknown[]) {
  if (verbose) console.log(...args)
}

// ─── SSE client management ──────────────────────────────────────────────────

const sseClients = new Set<http.ServerResponse>()

function sendSSE(res: http.ServerResponse, data: unknown) {
  try { res.write(`data: ${JSON.stringify(data)}\n\n`) } catch {
    sseClients.delete(res)
  }
}

function broadcast(data: string) {
  for (const res of sseClients) {
    try {
      // Slow/stalled consumer: drop it rather than buffer unboundedly in memory.
      if (res.writableLength > SSE_MAX_WRITABLE_BYTES) {
        sseClients.delete(res)
        res.destroy()
        continue
      }
      res.write(`data: ${data}\n\n`)
    } catch {
      sseClients.delete(res)
    }
  }
}

// ─── Event buffering ────────────────────────────────────────────────────────

/** Extra events allowed above MAX_EVENT_BUFFER before a trim pass runs. */
const EVENT_BUFFER_TRIM_SLACK = 2000
const eventBuffer = new Map<string, AgentEvent[]>()

function broadcastEvent(event: AgentEvent) {
  sessionEventCount++
  if (event.sessionId) event = { ...event, seq: seqAssigner.next(event.sessionId) }
  if (event.type === 'model_detected') {
    const m = (event.payload as { model?: unknown } | undefined)?.model
    if (typeof m === 'string' && m.length > 0) observedModels.add(m)
  }
  const sid = event.sessionId?.slice(0, SESSION_ID_DISPLAY) || '?'
  log(`[event] ${event.type} (session ${sid})`)

  if (event.sessionId) {
    let buf = eventBuffer.get(event.sessionId)
    if (!buf) {
      // Hook-only sessions are never in `sessions`, so pruneOldSessions can't
      // reap them — bound the map so it can't grow forever.
      if (eventBuffer.size >= MAX_BUFFERED_SESSIONS) {
        const oldest = eventBuffer.keys().next().value
        if (oldest !== undefined) eventBuffer.delete(oldest)
      }
      buf = []
      eventBuffer.set(event.sessionId, buf)
    }
    buf.push(event)
    // Amortised: trim in batches, keeping structural events (see trimEventBuffer)
    if (buf.length > MAX_EVENT_BUFFER + EVENT_BUFFER_TRIM_SLACK) trimEventBuffer(buf, MAX_EVENT_BUFFER)
  }

  broadcast(JSON.stringify({ type: 'agent-event', event }))
}

function broadcastSessionLifecycle(type: 'started' | 'ended' | 'updated', sessionId: string, label: string) {
  if (type === 'started') {
    broadcast(JSON.stringify({
      type: 'session-started',
      session: { id: sessionId, label, status: 'active', startTime: Date.now(), lastActivityTime: Date.now() } as SessionInfo,
    }))
  } else if (type === 'ended') {
    broadcast(JSON.stringify({ type: 'session-ended', sessionId }))
  } else if (type === 'updated') {
    broadcast(JSON.stringify({ type: 'session-updated', sessionId, label }))
  }
}

// ─── SSE replay ─────────────────────────────────────────────────────────────

/** Resolves when the socket's buffer drains, or false on close/timeout. */
function waitForDrain(res: http.ServerResponse, isClosed: () => boolean): Promise<boolean> {
  return new Promise((resolve) => {
    if (isClosed()) return resolve(false)
    const timer = setTimeout(() => finish(false), REPLAY_DRAIN_TIMEOUT_MS)
    const finish = (ok: boolean) => {
      clearTimeout(timer)
      res.off('drain', onDrain)
      res.off('close', onClose)
      resolve(ok)
    }
    const onDrain = () => finish(true)
    const onClose = () => finish(false)
    res.once('drain', onDrain)
    res.once('close', onClose)
  })
}

/** Stream events newer than `since` for the given sessions in bounded chunks.
 *  Loops until a full pass finds nothing new, so the caller can add the client
 *  to the live set synchronously afterwards with no gap. Returns false if the
 *  client went away or stalled. */
async function replayToClient(
  res: http.ServerResponse,
  getSessionIds: () => string[],
  since: Map<string, number>,
  isClosed: () => boolean,
  onCaughtUp: () => void,
): Promise<boolean> {
  const cursor = new Map(since)
  for (;;) {
    let sentAny = false
    // Re-evaluated each pass: sessions created while we were awaiting drain are included
    for (const sid of getSessionIds()) {
      const buf = eventBuffer.get(sid)
      if (!buf) continue
      let start = firstIndexAfter(buf, cursor.get(sid) ?? 0)
      while (start < buf.length) {
        const chunk = buf.slice(start, start + REPLAY_CHUNK_EVENTS)
        cursor.set(sid, chunk[chunk.length - 1].seq ?? cursor.get(sid) ?? 0)
        sentAny = true
        let ok = true
        try { ok = res.write(`data: ${JSON.stringify({ type: 'agent-event-batch', events: chunk })}\n\n`) } catch { return false }
        if (!ok && !(await waitForDrain(res, isClosed))) {
          if (!isClosed()) res.destroy()
          return false
        }
        if (isClosed()) return false
        // buffer may have been front-trimmed while we awaited: re-locate by seq
        start = firstIndexAfter(buf, cursor.get(sid) ?? 0)
      }
    }
    if (!sentAny) {
      // Still synchronous with the empty pass above: no event can slip in before the client joins
      onCaughtUp()
      return true
    }
  }
}

// ─── Session watcher ────────────────────────────────────────────────────────

const sessions = new Map<string, WatchedSession>()

function elapsed(sessionId?: string): number {
  if (sessionId) {
    const session = sessions.get(sessionId)
    if (session) return (Date.now() - session.sessionStartTime) / 1000
  }
  return 0
}

function emitContextUpdate(agentName: string, session: WatchedSession, sessionId?: string) {
  broadcastEvent({
    time: elapsed(sessionId),
    type: 'context_update',
    payload: { agent: agentName, ...buildContextPayload(session, agentName) },
    sessionId,
  })
}

function emitEvent(event: AgentEvent, sessionId?: string) {
  broadcastEvent(sessionId ? { ...event, sessionId } : event)
}

function filterHookEvent(event: AgentEvent): AgentEvent | null {
  // Matches extension/src/claude-runtime.ts's watcherHandlesThis fallback
  // exactly: a sessionless event is treated as handled-by-watcher whenever
  // ANY session is currently active (SessionWatcher.isActive() there,
  // sessions.size > 0 here), not as always-unhandled. These two consumers
  // of HookServer had already drifted on exactly this point once before —
  // see the comment above hookServer.onEvent() — which is why the actual
  // filtering policy now lives in one shared module instead of two copies.
  const watcherHandlesThis = event.sessionId ? sessions.has(event.sessionId) : sessions.size > 0
  if (!watcherHandlesThis) return event
  return filterHookEventForWatchedSession(event)
}

const parser = new TranscriptParser({
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  fireSessionLifecycle: (event) => broadcastSessionLifecycle(event.type, event.sessionId, event.label),
  emitContextUpdate,
  scanSubagents: (sessionId: string) => scanSubagentsDir(watcherDelegate, parser, sessionId),
})

const watcherDelegate = {
  emit: emitEvent,
  elapsed,
  getSession: (sessionId: string) => sessions.get(sessionId),
  getLastActivityTime: (sessionId: string) => sessions.get(sessionId)?.lastActivityTime,
  resetInactivityTimer: (sessionId: string) => resetInactivityTimer(sessionId),
}

function resetInactivityTimer(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const wasCompleted = session.sessionCompleted
  session.lastActivityTime = Date.now()
  session.sessionCompleted = false

  if (wasCompleted) {
    broadcastEvent({
      time: elapsed(sessionId),
      type: 'agent_spawn',
      payload: { name: ORCHESTRATOR_NAME, isMain: true, agentType: deriveAgentType(true), task: session.label, ...(session.model ? { model: session.model } : {}) },
      sessionId,
    })
    broadcastSessionLifecycle('started', sessionId, session.label)
  }

  if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
  session.inactivityTimer = setTimeout(() => {
    if (!session.sessionCompleted && session.sessionDetected) {
      log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} inactive`)
      session.sessionCompleted = true
      broadcastEvent({
        time: elapsed(sessionId),
        type: 'agent_complete',
        payload: { name: ORCHESTRATOR_NAME },
        sessionId,
      })
      broadcastSessionLifecycle('ended', sessionId, session.label)
    }
  }, INACTIVITY_TIMEOUT_MS)
}

async function watchSession(sessionId: string, filePath: string): Promise<void> {
  const defaultLabel = `Session ${sessionId.slice(0, SESSION_ID_DISPLAY)}`
  const session: WatchedSession = {
    sessionId, filePath,
    fileWatcher: null, pollTimer: null, fileSize: 0, fileTail: '',
    sessionStartTime: Date.now(),
    pendingToolCalls: new Map(),
    seenToolUseIds: new Set(),
    seenMessageHashes: new Set(),
    sessionDetected: false, sessionCompleted: false,
    lastActivityTime: Date.now(),
    inactivityTimer: null,
    subagentWatchers: new Map(),
    spawnedSubagents: new Set(),
    pendingCatchUpSpawns: [],
    inlineProgressAgents: new Set(),
    subagentsDirWatcher: null, subagentsDir: null,
    label: defaultLabel, labelSet: false,
    model: null,
    modelDetectedAgents: new Map(),
    permissionTimer: null, permissionEmitted: false,
    contextBreakdown: { systemPrompt: SYSTEM_PROMPT_BASE_TOKENS, userMessages: 0, toolResults: 0, reasoning: 0, subagentResults: 0 },
  }
  sessions.set(sessionId, session)

  const stat = fs.statSync(filePath)
  // Async + chunked so a huge transcript does not freeze SSE/timers; live tailing starts after the scan.
  const catchUpEntries = await parser.prescanExistingContentAsync(filePath, stat.size, session, {
    isCancelled: () => sessions.get(sessionId) !== session,
  })
  if (sessions.get(sessionId) !== session) return // pruned mid-scan
  session.fileSize = stat.size
  parser.extractSessionLabel(catchUpEntries, session)

  broadcastSessionLifecycle('started', sessionId, session.label)
  broadcastEvent({
    time: 0, type: 'agent_spawn',
    payload: { name: ORCHESTRATOR_NAME, isMain: true, agentType: deriveAgentType(true), task: session.label, ...(session.model ? { model: session.model } : {}) },
    sessionId,
  })
  session.sessionDetected = true
  parser.emitPendingSubagentSpawns(session, sessionId)

  emitContextUpdate(ORCHESTRATOR_NAME, session, sessionId)
  parser.emitCatchUpEntries(catchUpEntries, session, sessionId)

  // Debounced: Windows fires several 'change' events per write; one read
  // after the burst settles is enough. lastWatchEvent lets the fallback poll
  // stand down while the watcher is demonstrably delivering events.
  let debounce: NodeJS.Timeout | null = null
  let lastWatchEvent = 0
  const watchTranscript = () => fs.watch(session.filePath, (eventType) => {
    if (eventType !== 'change') return
    lastWatchEvent = Date.now()
    if (debounce) return
    debounce = setTimeout(() => { debounce = null; readNewLines(sessionId) }, WATCH_DEBOUNCE_MS)
  })
  session.fileWatcher = watchTranscript()

  session.pollTimer = setInterval(() => {
    // Entering a worktree moves the transcript to another project folder
    if (followSession(watcherDelegate, parser, session, CLAUDE_DIR)) {
      log(`[session] ${sessionId.slice(0, SESSION_ID_DISPLAY)} moved to ${session.filePath}`)
      session.fileWatcher?.close()
      try { session.fileWatcher = watchTranscript() } catch {}
    }
    // Fallback only: skip the reads when fs.watch fired within the last interval.
    if (Date.now() - lastWatchEvent < POLL_FALLBACK_MS) return
    // readNewLines already rescans the subagents dir
    readNewLines(sessionId)
    for (const [subPath] of session.subagentWatchers) {
      readSubagentNewLines(watcherDelegate, parser, subPath, sessionId)
    }
  }, POLL_FALLBACK_MS)

  session.subagentsDir = path.join(path.dirname(filePath), sessionId, 'subagents')
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)

  log(`[session] Watching ${sessionId.slice(0, SESSION_ID_DISPLAY)} — "${session.label}"`)
}

function readNewLines(sessionId: string) {
  const session = sessions.get(sessionId)
  if (!session) return

  const result = readNewFileLines(session.filePath, session.fileSize, session.fileTail)
  if (!result) return
  session.fileSize = result.newSize
  session.fileTail = result.tail
  for (const line of result.lines) {
    parser.processTranscriptLine(line, ORCHESTRATOR_NAME, session.pendingToolCalls, session.seenToolUseIds, sessionId, session.seenMessageHashes)
  }

  handlePermissionDetection(watcherDelegate, ORCHESTRATOR_NAME, session.pendingToolCalls, session, sessionId, session.sessionCompleted, true)
  scanSubagentsDir(watcherDelegate, parser, sessionId)
  resetInactivityTimer(sessionId)
}

// Drops sessions that finished (sessionCompleted) more than
// SESSION_RETENTION_MS ago from `sessions`/`eventBuffer` — otherwise every
// session ever watched during this process's lifetime stays in the SSE
// session-list forever and gets its full event buffer replayed on every
// reconnect. Mirrors the watcher cleanup already done in dispose().
function pruneOldSessions() {
  const now = Date.now()
  for (const [sessionId, session] of sessions) {
    if (!session.sessionCompleted) continue
    if (now - session.lastActivityTime < SESSION_RETENTION_MS) continue

    session.fileWatcher?.close()
    if (session.pollTimer) clearInterval(session.pollTimer)
    if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
    sessions.delete(sessionId)
    eventBuffer.delete(sessionId)
    log(`[session] Pruned ${sessionId.slice(0, SESSION_ID_DISPLAY)} (idle since completion > ${SESSION_RETENTION_MS}ms)`)
  }
}

// ─── Session scanner ────────────────────────────────────────────────────────

function scanForActiveSessions(workspace: string) {
  if (!fs.existsSync(CLAUDE_DIR)) return

  let resolved = workspace
  try { resolved = fs.realpathSync(resolved) } catch {}
  const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')

  const dirsToScan: string[] = []
  // Case-folded on Windows — VS Code/shells report `c:\...` while Claude Code
  // encodes `C--...`, so exact string matching never found the project dir there.
  const encodedFolded = foldPathCase(encoded)
  try {
    for (const dir of fs.readdirSync(CLAUDE_DIR, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue
      const nameFolded = foldPathCase(dir.name)
      if (nameFolded === encodedFolded || nameFolded.startsWith(encodedFolded + '-')) {
        dirsToScan.push(path.join(CLAUDE_DIR, dir.name))
      }
    }
  } catch {
    // readdir failed — fall back to the exact-match dir if it exists
    const projectDir = path.join(CLAUDE_DIR, encoded)
    if (fs.existsSync(projectDir)) dirsToScan.push(projectDir)
  }

  for (const dirPath of dirsToScan) {
    try {
      for (const file of fs.readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue
        const filePath = path.join(dirPath, file)
        const stat = fs.statSync(filePath)
        const sessionId = path.basename(file, '.jsonl')

        // Subagent writes (including nested workflows/wf_*/ files) keep a
        // session alive when the main JSONL is stale. Only walk the tree when
        // the main file alone doesn't qualify.
        let newestMtime = stat.mtimeMs
        if ((Date.now() - newestMtime) / 1000 > ACTIVE_SESSION_AGE_S) {
          const subMtime = newestSubagentMtime(path.join(dirPath, sessionId, 'subagents'))
          if (subMtime > newestMtime) newestMtime = subMtime
        }

        const ageSeconds = (Date.now() - newestMtime) / 1000
        if (ageSeconds <= ACTIVE_SESSION_AGE_S && !sessions.has(sessionId)) {
          watchSession(sessionId, filePath).catch(err => log(`[session] watch failed: ${err}`))
        }
      }
    } catch {}
  }
}

// ─── Discovery file ─────────────────────────────────────────────────────────

function normalizePath(p: string): string {
  let resolved = path.resolve(p)
  try { resolved = fs.realpathSync(resolved) } catch {}
  return resolved
}

function hashWorkspace(workspace: string): string {
  return crypto.createHash('sha256').update(normalizePath(workspace)).digest('hex').slice(0, WORKSPACE_HASH_LENGTH)
}

let discoveryFilePath: string | null = null

function writeDiscoveryFile(port: number, workspace: string) {
  if (!fs.existsSync(DISCOVERY_DIR)) fs.mkdirSync(DISCOVERY_DIR, { recursive: true })
  const hash = hashWorkspace(workspace)
  discoveryFilePath = path.join(DISCOVERY_DIR, `${hash}-${process.pid}.json`)
  const tmp = `${discoveryFilePath}.${process.pid}.tmp`
  const body = JSON.stringify({ port, pid: process.pid, workspace: normalizePath(workspace) }, null, 2) + '\n'
  fs.writeFileSync(tmp, body)
  try {
    fs.renameSync(tmp, discoveryFilePath)
  } catch {
    // Windows can refuse rename-over while a reader holds the target
    fs.writeFileSync(discoveryFilePath, body)
  } finally {
    try { fs.unlinkSync(tmp) } catch { /* already renamed */ }
  }
}

function removeDiscoveryFile() {
  if (discoveryFilePath) {
    try { fs.unlinkSync(discoveryFilePath) } catch {}
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface Relay {
  /** Handle an incoming SSE connection */
  handleSSE: (req: http.IncomingMessage, res: http.ServerResponse) => void
  /** Clean up all resources */
  dispose: () => void
}

export type RelayRuntimeMode = 'claude' | 'codex' | 'auto'

export interface RelayOptions {
  workspace: string
  verbose?: boolean
  telemetry?: TelemetryClient
  /** Which runtimes to watch. Defaults to AGENT_FLOW_RUNTIME env var, or 'auto'.
   *  Mirrors the extension's `agentVisualizer.runtime` setting so users of the
   *  dev relay and `npx agent-flow-app` have a way to opt out of one runtime. */
  runtime?: RelayRuntimeMode
}

function resolveRuntimeMode(explicit?: RelayRuntimeMode): RelayRuntimeMode {
  if (explicit === 'claude' || explicit === 'codex' || explicit === 'auto') return explicit
  const raw = process.env.AGENT_FLOW_RUNTIME
  return raw === 'claude' || raw === 'codex' ? raw : 'auto'
}

/** Maximum concurrent SSE clients; further /events requests get a 503. */
export const MAX_SSE_CLIENTS = 200

export async function createRelay(options: RelayOptions): Promise<Relay> {
  const { workspace } = options
  verbose = options.verbose ?? false
  // Keep warnings visible without --verbose — actionable hints (e.g. "Codex
  // sessions exist but none match this workspace") must reach the user.
  if (!verbose) setLogLevel('warn')
  if (relayCreated) {
    throw new Error('createRelay() can only be called once per process')
  }
  relayCreated = true

  const mode = resolveRuntimeMode(options.runtime)
  const wantClaude = mode === 'claude' || mode === 'auto'
  const wantCodex = mode === 'codex' || mode === 'auto'
  log(`[relay] Runtime mode: ${mode} (watching: ${[wantClaude && 'claude', wantCodex && 'codex'].filter(Boolean).join(', ')})`)

  let hookServer: HookServer | null = null
  let scanInterval: NodeJS.Timeout | null = null
  let pruneInterval: NodeJS.Timeout | null = null
  let projectDirWatcher: fs.FSWatcher | null = null

  if (wantClaude) {
    hookServer = new HookServer()
    const hookPort = await hookServer.start()
    if (hookPort === HOOK_SERVER_NOT_STARTED) {
      throw new Error('Failed to start hook server (port in use)')
    }

    hookServer.onEvent((event: AgentEvent) => {
      // Route through broadcastEvent (not raw broadcast) so hook-sourced
      // events (tool_call_start/end, subagent_return, agent_complete, etc.)
      // are buffered like every other event source and survive SSE reconnects.
      //
      // Subagent lifecycle events need filtering first, mirroring
      // extension/src/claude-runtime.ts: when this session's transcript is
      // already being parsed (watchSession() below), the TranscriptParser is
      // the authority on subagent spawn/completion — it names subagents from
      // the Task's description, while the hook server names them generically
      // as `${agentType}-${agentId.slice(-N)}` (see hook-server.ts
      // handleSubagentStart/handleSubagentStop). Letting the hook's
      // agent_complete through unfiltered sends a completion signal for a
      // node name that was never spawned under that name, so it silently
      // no-ops and the real node is left looking stuck/active until the
      // (possibly lagging) transcript-driven completion catches up.
      const filtered = filterHookEvent(event)
      if (filtered) broadcastEvent(filtered)
    })

    writeDiscoveryFile(hookPort, workspace)

    scanForActiveSessions(workspace)
    scanInterval = setInterval(() => scanForActiveSessions(workspace), RELAY_SCAN_INTERVAL_MS)
    pruneInterval = setInterval(pruneOldSessions, SESSION_PRUNE_INTERVAL_MS)

    const resolved = (() => { try { return fs.realpathSync(workspace) } catch { return workspace } })()
    const encoded = resolved.replace(/[^a-zA-Z0-9]/g, '-')
    const projectDir = path.join(CLAUDE_DIR, encoded)
    if (fs.existsSync(projectDir)) {
      try {
        projectDirWatcher = fs.watch(projectDir, (_eventType, filename) => {
          if (filename?.endsWith('.jsonl')) scanForActiveSessions(workspace)
        })
      } catch {}
    }
  }

  // ─── Codex runtime ────────────────────────────────────────────────────────
  // Watch Codex rollouts in parallel. No-op if ~/.codex/sessions doesn't
  // exist or no sessions match the current workspace.
  // We don't subscribe to onSessionDetected — it fires together with the
  // lifecycle 'started' event in CodexSessionWatcher.attachSession, so
  // wiring both would double-broadcast session-started to SSE clients.
  let codexWatcher: CodexSessionWatcher | null = null
  if (wantCodex) {
    codexWatcher = new CodexSessionWatcher(workspace)
    codexWatcher.onEvent((event) => broadcastEvent(event))
    codexWatcher.onSessionLifecycle((lifecycle) => {
      broadcastSessionLifecycle(lifecycle.type, lifecycle.sessionId, lifecycle.label)
    })
    codexWatcher.start()
  }

  const telemetry = options.telemetry
  const sessionStart = Date.now()
  let relayDisposed = false
  const relaySessionId = `relay-${process.pid}-${Math.floor(sessionStart / 1000)}`
  sessionEventCount = 0

  const agentFlowVersion = resolveAgentFlowVersion()

  const baseEvent = () => ({
    session_id: relaySessionId,
    agent_flow_version: agentFlowVersion,
    os: os.platform(),
    arch: os.arch(),
  })

  telemetry?.emit({ ...baseEvent(), event_type: 'session_start' })

  process.on('uncaughtException', (err) => {
    try {
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'error',
        error_class: err?.constructor?.name ?? 'Error',
      })
    } catch { /* don't let the handler itself crash */ }
    // Preserve default crash-on-uncaught behavior: log, then exit.
    console.error(err)
    process.exit(1)
  })

  return {
    handleSSE(req: http.IncomingMessage, res: http.ServerResponse) {
      if (sseClients.size >= MAX_SSE_CLIENTS) {
        res.writeHead(503, { 'Content-Type': 'text/plain', 'Retry-After': '5', 'Cache-Control': 'no-store' })
        res.end('Too many event-stream clients')
        return
      }
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      // Tell EventSource how long to wait before reconnecting, then identify
      // this server run: seq numbers are only comparable within one epoch.
      res.write('retry: 3000\n\n')
      sendSSE(res, { type: 'hello', epoch: BOOT_ID })

      let closed = false
      // Comment-line heartbeat keeps proxies/NAT from idling out the stream
      // and surfaces dead sockets via write errors.
      const heartbeat = setInterval(() => {
        try { res.write(': ping\n\n') } catch { cleanupClient() }
      }, SSE_HEARTBEAT_MS)
      const cleanupClient = () => {
        closed = true
        clearInterval(heartbeat)
        if (sseClients.delete(res)) log(`[sse] Client disconnected (${sseClients.size} total)`)
      }
      req.on('close', cleanupClient)
      res.on('close', cleanupClient)
      res.on('error', cleanupClient)

      // Current session list (Claude + Codex)
      const buildSessionList = (): SessionInfo[] => {
      const sessionList: SessionInfo[] = []
      for (const session of sessions.values()) {
        if (!session.sessionDetected) continue
        sessionList.push({
          id: session.sessionId, label: session.label,
          status: session.sessionCompleted ? 'completed' : 'active',
          startTime: session.sessionStartTime, lastActivityTime: session.lastActivityTime,
        })
      }
      if (codexWatcher) sessionList.push(...codexWatcher.getActiveSessions())
      return sessionList
      }
      const initialList = buildSessionList()
      if (initialList.length > 0) {
        sendSSE(res, { type: 'session-list', sessions: initialList })
      }

      // Replay buffered events for ALL known sessions (not just the active one),
      // but only those newer than the client's per-session cursor. The client
      // sends `?epoch=<hello.epoch>&since=sid:seq,...`; a stale epoch means a
      // relay restart, so it gets the full buffer. Written in chunks honouring
      // backpressure; the client joins the live broadcast set only once it has
      // caught up, so no event is skipped or delivered out of order.
      let since = new Map<string, number>()
      try { since = resolveSince(new URL(req.url ?? '/', 'http://localhost').searchParams, BOOT_ID) } catch { /* bad URL: full replay */ }
      void replayToClient(res, () => buildSessionList().map(s => s.id), since, () => closed, () => {
        if (closed) return
        // Final list (sessions that appeared/changed during replay), then join live
        const finalList = buildSessionList()
        if (finalList.length > 0) sendSSE(res, { type: 'session-list', sessions: finalList })
        sseClients.add(res)
        log(`[sse] Client connected (${sseClients.size} total)`)
      })
    },

    dispose() {
      // Defense in depth — server.ts already guards cleanup(), but direct
      // callers or hot-reload could call this twice.
      if (relayDisposed) return
      relayDisposed = true
      const models = [...observedModels].sort().join(',').slice(0, 128)
      const runtimes = [wantClaude && 'claude', wantCodex && 'codex'].filter(Boolean).join(',')
      telemetry?.emit({
        ...baseEvent(),
        event_type: 'session_end',
        duration_s: Math.round((Date.now() - sessionStart) / 1000),
        event_count: sessionEventCount,
        models: models || undefined,
        runtimes: runtimes || undefined,
      })
      if (wantClaude) {
        removeDiscoveryFile()
        hookServer?.dispose()
        if (scanInterval) clearInterval(scanInterval)
        if (pruneInterval) clearInterval(pruneInterval)
        projectDirWatcher?.close()
        for (const session of sessions.values()) {
          session.fileWatcher?.close()
          if (session.pollTimer) clearInterval(session.pollTimer)
          if (session.inactivityTimer) clearTimeout(session.inactivityTimer)
        }
      }
      codexWatcher?.dispose()
    },
  }
}
