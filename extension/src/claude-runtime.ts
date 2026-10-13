/**
 * Claude Code runtime.
 *
 * Wires together the two event sources for a Claude Code session:
 *   1. Hook server — receives live events via a stdin-piped hook script
 *      configured in Claude's settings.json
 *   2. Session watcher — tails Claude Code's JSONL transcripts at
 *      ~/.claude/projects/<encoded>/<session>.jsonl
 *
 * Both sources can be active simultaneously; this runtime routes hook
 * events around the watcher when the watcher is already parsing that
 * session's transcript, to avoid duplicate events with divergent names
 * (hooks use agent_type+id; transcripts use description).
 */

import * as vscode from 'vscode'
import { HookServer } from './hook-server'
import { SessionWatcher } from './session-watcher'
import { VisualizerPanel } from './webview-provider'
import { HOOK_SERVER_NOT_STARTED } from './constants'
import { migrateHttpHooks } from './hooks-config'
import {
  writeDiscoveryFile, removeDiscoveryFile, ensureHookScript,
} from './discovery'
import { createLogger } from './logger'
import { wireWatcherToPanel } from './session-runtime'
import type { AgentRuntime } from './session-runtime'
import { filterOrchestratorCompletion, filterHookEventForWatchedSession } from './subagent-event-filter'

const log = createLogger('ClaudeRuntime')

export async function startClaudeRuntime(
  context: vscode.ExtensionContext,
): Promise<AgentRuntime> {
  // ─── Hook server ───────────────────────────────────────────────────────────
  const hookServer = new HookServer()
  context.subscriptions.push(hookServer)

  let hookPort: number
  try {
    hookPort = await hookServer.start()
  } catch (err) {
    log.error('Failed to start hook server:', err)
    hookPort = HOOK_SERVER_NOT_STARTED
  }

  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath

  if (hookPort === HOOK_SERVER_NOT_STARTED) {
    log.info('Hook server skipped (another instance owns the port) — using session watcher only')
  } else {
    log.info(`Hook server running on port ${hookPort}`)

    // Write discovery file so the hook script can find us.
    // The hook script reads this at invocation time — no port in settings.json.
    if (workspace) {
      ensureHookScript()
      writeDiscoveryFile(hookPort, workspace)
      migrateHttpHooks()
    }
  }

  // ─── Session watcher ───────────────────────────────────────────────────────
  const watcher = new SessionWatcher()
  context.subscriptions.push(watcher)

  // Route hook events → panel, but filter out events the watcher already owns
  if (hookPort !== HOOK_SERVER_NOT_STARTED) {
    hookServer.onEvent((event) => {
      const panel = VisualizerPanel.getCurrent()
      if (!panel || !panel.isReady) return

      const eventSessionId = event.sessionId
      const watcherHandlesThis = eventSessionId
        ? watcher.isSessionActive(eventSessionId)
        : watcher.isActive()

      if (watcherHandlesThis) {
        const filtered = filterHookEventForWatchedSession(event)
        if (filtered) panel.sendEvent(filtered)
        return
      }

      panel.sendEvent(event)
      panel.setConnectionStatus('watching', `Claude Code hooks (:${hookPort})`)
    })
  }

  // Route watcher events + lifecycle → panel (with orchestrator completion filter)
  const wiring = wireWatcherToPanel(watcher, {
    sessionLabelPrefix: 'Claude',
    transformEvent: filterOrchestratorCompletion,
  })

  watcher.start()

  const connectionStatus = (): string => {
    if (hookPort > 0) return `Hooks :${hookPort} + session watcher`
    return 'Session watcher'
  }

  const dispose = (): void => {
    // Remove our discovery file so the hook script won't forward to a dead port.
    // Hook entries in settings.json are left intact — the command is stable
    // (node ~/.claude/agent-flow/hook.js) and the script handles dead instances
    // gracefully via PID checks. This avoids breaking multi-window setups and
    // means hooks survive VS Code restarts without reconfiguration.
    if (workspace) { removeDiscoveryFile(workspace) }
    wiring.dispose()
    hookServer.dispose()
    watcher.dispose()
  }

  return { mode: 'claude', watcher, connectionStatus, dispose }
}
