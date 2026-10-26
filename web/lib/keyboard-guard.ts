/**
 * Decides whether a global keydown should be ignored by the app shortcuts.
 * - Browser/OS chords (Ctrl/Cmd/Alt + key) must pass through (copy, find, save...).
 * - Typing targets (input, textarea, select, contenteditable) own their keys.
 * - Space/Enter on a focused button/link is native activation; hijacking Space
 *   there would double-toggle play/pause.
 */
export interface KeyGuardInput {
  key: string
  ctrlKey: boolean
  metaKey: boolean
  altKey: boolean
  tagName: string | null
  isContentEditable: boolean
}

export function shouldIgnoreShortcut(i: KeyGuardInput): boolean {
  if (i.ctrlKey || i.metaKey || i.altKey) return true
  if (i.isContentEditable) return true
  const tag = i.tagName?.toUpperCase() ?? ''
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  if ((i.key === ' ' || i.key === 'Enter') && (tag === 'BUTTON' || tag === 'A')) return true
  return false
}
