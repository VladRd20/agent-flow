// Classifies raw transcript JSONL lines: which ones are real conversation
// activity (may revive a finished session) and which one means "/clear".
// Shared by the relay and the VS Code session watcher.

type Parsed = Record<string, unknown>

/** Parses one JSONL line; null when blank or not a JSON object. */
export function parseTranscriptLine(line: string): Parsed | null {
  const t = line.trim()
  if (!t) return null
  try {
    const v = JSON.parse(t) as unknown
    return v && typeof v === 'object' ? (v as Parsed) : null
  } catch { return null }
}

/**
 * True for lines that show the conversation is really going on: user/assistant
 * messages that are not isMeta, plus progress (tool/subagent) entries.
 * Bookkeeping (queue-operation, cost-state, bridge-session, custom-title,
 * agent-name, file-history-snapshot, system, attachment, ...) is false.
 */
export function isConversationEntry(parsed: Parsed | null): boolean {
  if (!parsed) return false
  const type = parsed.type
  if (type === 'progress') return true
  if (type === 'user' || type === 'assistant') return parsed.isMeta !== true
  return false
}

export function isConversationLine(line: string): boolean {
  return isConversationEntry(parseTranscriptLine(line))
}

/** True for the queue-operation enqueue Claude Code writes when the user runs /clear. */
export function isClearCommandEntry(parsed: Parsed | null): boolean {
  if (!parsed || parsed.type !== 'queue-operation' || parsed.operation !== 'enqueue') return false
  return typeof parsed.content === 'string' && parsed.content.trim() === '/clear'
}

export function isClearCommandLine(line: string): boolean {
  return isClearCommandEntry(parseTranscriptLine(line))
}

/**
 * Folds a batch of new lines into one decision, in order: a later /clear ends
 * the session, a later real conversation line re-opens it.
 */
export function classifyTranscriptLines(lines: string[]): { conversation: boolean; ended: boolean } {
  let conversation = false
  let ended = false
  for (const line of lines) {
    const parsed = parseTranscriptLine(line)
    if (isClearCommandEntry(parsed)) { ended = true; conversation = false }
    else if (isConversationEntry(parsed)) { ended = false; conversation = true }
  }
  return { conversation, ended }
}
