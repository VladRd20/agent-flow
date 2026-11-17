import * as path from 'path'

/**
 * Strips leading @mention tokens (quoted @"..." and bare @path) and leading
 * whitespace from a prompt. If nothing else remains, falls back to the basename
 * of the first mentioned file. Returns '' when there is neither text nor mention.
 */
export function cleanLabelText(text: string): string {
  let rest = text.replace(/^\s+/, '')
  let firstMention: string | null = null
  for (;;) {
    const quoted = /^@"([^"\n]*)"\s*/.exec(rest)
    const bare = quoted ? null : /^@(\S+)\s*/.exec(rest)
    const m = quoted ?? bare
    if (!m) break
    if (firstMention === null) firstMention = m[1]
    rest = rest.slice(m[0].length)
  }
  if (rest.trim()) return rest
  if (firstMention) return path.win32.basename(firstMention.replace(/\//g, '\\')) || firstMention
  return ''
}
