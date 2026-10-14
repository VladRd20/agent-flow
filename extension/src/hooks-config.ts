import * as vscode from 'vscode'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { ClaudeHookEntry } from './protocol'
import { HOOK_SERVER_HOST, HOOK_TIMEOUT_S } from './constants'
import {
  HOOK_COMMAND_MARKER,
  getHookCommand, ensureHookScript,
  addWorkspaceToManifest,
} from './discovery'
import { createLogger } from './logger'

const log = createLogger('Hooks')

const GLOBAL_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json')

// Legacy Agent Flow HTTP hooks were always the bare origin (e.g.
// "http://127.0.0.1:51234") with no path — the whole origin was the
// webhook target. Matching on HOOK_URL_PREFIX alone (a startsWith check)
// also caught other tools' loopback hooks that merely shared the host,
// e.g. "http://127.0.0.1:9229/some-other-endpoint", and deleted them on
// install. Require an exact bare-origin match instead.
const LEGACY_HOOK_URL_RE = new RegExp(`^http://${HOOK_SERVER_HOST}:\\d+/?$`)

/** Read and parse Claude Code's global settings.json.
 *  Returns null if the file doesn't exist, or 'parse-error' if it exists
 *  but can't be parsed — callers must not treat the latter as "no settings
 *  yet" (that would silently discard the user's existing file on write). */
function readGlobalSettings(): Record<string, unknown> | null | 'parse-error' {
  try {
    if (!fs.existsSync(GLOBAL_SETTINGS_PATH)) { return null }
    return JSON.parse(fs.readFileSync(GLOBAL_SETTINGS_PATH, 'utf-8'))
  } catch (err) {
    log.debug('Failed to read Claude settings:', err)
    return 'parse-error'
  }
}

/** Atomically write JSON to settingsPath (temp file + rename), so a crash
 *  or interrupted write can't truncate/corrupt the user's settings file. */
function writeSettingsAtomic(settingsPath: string, settings: unknown): void {
  const tmpPath = `${settingsPath}.${process.pid}.tmp`
  fs.writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + '\n')
  fs.renameSync(tmpPath, settingsPath)
}

/** Check whether a single hook entry belongs to Agent Flow.
 *  Exported for tests only — not part of the module's public surface. */
export function isAgentFlowHook(entry: ClaudeHookEntry): boolean {
  return !!entry.hooks?.some(h =>
    // Normalize backslashes to forward slashes so Windows paths
    // (e.g. "C:\\Users\\...\\agent-flow\\hook.js") match HOOK_COMMAND_MARKER.
    h.command?.replace(/\\/g, '/').includes(HOOK_COMMAND_MARKER) ||
    (h.url !== undefined && LEGACY_HOOK_URL_RE.test(h.url)),
  )
}

// ─── Detection ────────────────────────────────────────────────────────────────

function hooksAlreadyConfigured(): boolean {
  if (hasAgentFlowHooks(GLOBAL_SETTINGS_PATH)) { return true }

  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspaceFolder) {
    const projectPath = path.join(workspaceFolder, '.claude', 'settings.local.json')
    if (hasAgentFlowHooks(projectPath)) {
      // Backfill manifest for workspaces configured before the manifest existed
      addWorkspaceToManifest(workspaceFolder)
      return true
    }
  }

  return false
}

function hasAgentFlowHooks(settingsPath: string): boolean {
  try {
    if (!fs.existsSync(settingsPath)) { return false }
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf-8'))
    const hooks = settings.hooks
    if (!hooks || typeof hooks !== 'object') { return false }
    return Object.values(hooks).some((entries: unknown) => {
      if (!Array.isArray(entries)) { return false }
      return entries.some((entry: unknown) => isAgentFlowHook(entry as ClaudeHookEntry))
    })
  } catch (err) {
    log.debug('Failed to read hooks settings:', err)
    return false
  }
}

// ─── Configure ────────────────────────────────────────────────────────────────

export async function configureClaudeHooks(): Promise<void> {
  ensureHookScript()

  const hookCommand = getHookCommand()
  const hookEntry = { hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_S }] }

  const hooksConfig = {
    SessionStart: [hookEntry],
    PreToolUse: [hookEntry],
    PostToolUse: [hookEntry],
    PostToolUseFailure: [hookEntry],
    SubagentStart: [hookEntry],
    SubagentStop: [hookEntry],
    Notification: [hookEntry],
    Stop: [hookEntry],
    SessionEnd: [hookEntry],
  }

  // Read existing settings. A file that exists but fails to parse is left
  // untouched — proceeding with {} would silently replace it with a file
  // that contains only our hooks, discarding everything else in it.
  const existing = readGlobalSettings()
  if (existing === 'parse-error') {
    vscode.window.showErrorMessage(
      `Agent Flow: ${GLOBAL_SETTINGS_PATH} exists but couldn't be parsed as JSON. ` +
      'Fix or remove it, then retry hook setup — leaving it untouched for now.',
    )
    return
  }
  const settings: Record<string, unknown> = existing ?? {}

  // Merge hooks — preserve existing hooks, replace ours
  const existingHooks = (settings.hooks || {}) as Record<string, unknown[]>
  for (const [event, entries] of Object.entries(hooksConfig)) {
    const existing = existingHooks[event] || []
    // Remove previous agent-flow hooks (command or legacy HTTP)
    const filtered = existing.filter((entry: unknown) => !isAgentFlowHook(entry as ClaudeHookEntry))
    existingHooks[event] = [...filtered, ...entries]
  }

  settings.hooks = existingHooks

  // Write (temp file + rename, so an interrupted write can't truncate it)
  const dir = path.dirname(GLOBAL_SETTINGS_PATH)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  writeSettingsAtomic(GLOBAL_SETTINGS_PATH, settings)

  vscode.window.showInformationMessage(
    'Claude Code hooks configured. New sessions will stream events to Agent Flow.',
  )
}

// ─── Migration ────────────────────────────────────────────────────────────────

/** Replace legacy HTTP hooks with command hooks. Called once on activation.
 *  Caller must call ensureHookScript() first. */
export function migrateHttpHooks(): void {
  const pathsToCheck: string[] = [GLOBAL_SETTINGS_PATH]
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  if (workspaceFolder) {
    pathsToCheck.push(path.join(workspaceFolder, '.claude', 'settings.local.json'))
  }

  const hookCommand = getHookCommand()

  for (const settingsPath of pathsToCheck) {
    try {
      if (!fs.existsSync(settingsPath)) { continue }
      const raw = fs.readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(raw)
      const hooks = settings.hooks
      if (!hooks || typeof hooks !== 'object') { continue }

      let changed = false
      for (const entries of Object.values(hooks) as unknown[][]) {
        if (!Array.isArray(entries)) { continue }
        for (const entry of entries) {
          const e = entry as ClaudeHookEntry
          if (!e.hooks) { continue }
          for (const h of e.hooks) {
            if (h.url !== undefined && LEGACY_HOOK_URL_RE.test(h.url)) {
              // Replace HTTP hook with command hook
              delete h.url
              h.type = 'command'
              h.command = hookCommand
              if (h.timeout === undefined) { h.timeout = HOOK_TIMEOUT_S }
              changed = true
            }
          }
        }
      }

      if (changed) {
        writeSettingsAtomic(settingsPath, settings)
        log.info(`Migrated HTTP hooks → command hooks in ${settingsPath}`)
        // Ensure migrated project-level hooks are tracked in the manifest
        if (workspaceFolder && settingsPath.includes(workspaceFolder)) {
          addWorkspaceToManifest(workspaceFolder)
        }
      }
    } catch (err) {
      log.error(`Failed to migrate ${settingsPath}:`, err)
    }
  }
}

// ─── Claude Code Environment ─────────────────────────────────────────────────

/** Check whether CLAUDE_CODE_DISABLE_1M_CONTEXT is set (via env or Claude Code settings). */
export function isDisable1MContext(): boolean {
  if (process.env.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1') { return true }
  const settings = readGlobalSettings()
  if (!settings || settings === 'parse-error') { return false }
  return (settings.env as Record<string, unknown>)?.CLAUDE_CODE_DISABLE_1M_CONTEXT === '1'
}

// ─── Prompt ───────────────────────────────────────────────────────────────────

export async function promptHookSetupIfNeeded(_context: vscode.ExtensionContext): Promise<void> {
  if (hooksAlreadyConfigured()) { return }
  await configureClaudeHooks()
}
