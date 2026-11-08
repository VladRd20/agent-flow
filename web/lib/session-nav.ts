import type { SessionInfo } from '@/lib/bridge-types'

/** Counts for the All tab label: sessions that are running now vs. all sessions. */
export function sessionCounts(sessions: ReadonlyArray<Pick<SessionInfo, 'status'>>): { live: number; total: number } {
  let live = 0
  for (const s of sessions) if (s.status === 'active') live++
  return { live, total: sessions.length }
}

/** Visible label of the All tab: "All · 3 live / 12", or "All · 12" when nothing is running. */
export function allTabLabel(live: number, total: number): string {
  return live > 0 ? `All · ${live} live / ${total}` : `All · ${total}`
}

/** The next running (active) session after the selected one, wrapping around; null when there is none
 *  other than the selected session. When the All view (or an unknown id) is selected, starts from the first. */
export function nextRunningSessionId(
  sessions: ReadonlyArray<Pick<SessionInfo, 'id' | 'status'>>,
  selectedId: string | null,
): string | null {
  const n = sessions.length
  if (n === 0) return null
  const start = sessions.findIndex(s => s.id === selectedId)
  for (let step = 1; step <= n; step++) {
    const s = sessions[(start + step + n) % n]
    if (s.status === 'active' && s.id !== selectedId) return s.id
  }
  return null
}
