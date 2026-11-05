import type { SimulationEvent } from './agent-types'

/** Sentinel "session" id for the combined view of every session. */
export const ALL_SESSIONS_ID = '__all__'

/** localStorage key remembering the user's tab choice: "on" = All, "off" = a single session. Missing = All. */
export const ALL_VIEW_STORAGE_KEY = 'agent-flow:view-all'

/** Read the persisted choice. Anything but an explicit "off" means All. */
export function readAllViewPreference(): boolean {
  try { return localStorage.getItem(ALL_VIEW_STORAGE_KEY) !== 'off' } catch { return true }
}

export function writeAllViewPreference(all: boolean): void {
  try { localStorage.setItem(ALL_VIEW_STORAGE_KEY, all ? 'on' : 'off') } catch { /* ignore */ }
}

const NS_SEP = '::'

/** Namespaced agent key so identically named agents of different sessions don't collide. */
export function namespaceName(sessionId: string, name: string): string {
  return `${sessionId}${NS_SEP}${name}`
}

/** Payload fields that carry an agent name, per event type. */
export const NAME_FIELDS: Record<SimulationEvent['type'], readonly string[]> = {
  agent_spawn: ['name', 'parent'],
  agent_complete: ['name'],
  agent_idle: ['name'],
  model_detected: ['agent'],
  tool_call_start: ['agent'],
  tool_call_end: ['agent'],
  message: ['agent'],
  context_update: ['agent'],
  subagent_dispatch: ['parent', 'child'],
  subagent_return: ['parent', 'child'],
  permission_requested: ['agent'],
}

export interface SessionMeta {
  label: string
  /** Epoch ms the session's own clock started at (SessionInfo.startTime) */
  startTime: number
}

/** Shift a session-relative time (seconds) onto the common All clock. Never negative. */
export function shiftTime(time: number, sessionStartMs: number, baseMs: number): number {
  return Math.max(0, time + (sessionStartMs - baseMs) / 1000)
}

/** Earliest start among the given sessions (the common clock origin). */
export function computeAllBase(sessions: readonly { startTime: number }[]): number {
  let base = Infinity
  for (const s of sessions) if (s.startTime < base) base = s.startTime
  return Number.isFinite(base) ? base : Date.now()
}

/**
 * Convert one session event to the All-view form: names namespaced by session,
 * time moved to the common clock. agent_spawn also gets `displayName` (the
 * session label for a main agent, otherwise the original name) and `sessionId`.
 */
export function transformEventForAll(
  event: SimulationEvent,
  meta: SessionMeta | undefined,
  baseMs: number,
): SimulationEvent {
  const sid = event.sessionId
  if (!sid) return event
  const payload: Record<string, unknown> = { ...event.payload }
  for (const field of NAME_FIELDS[event.type] ?? []) {
    const v = payload[field]
    if (typeof v === 'string' && v !== '') payload[field] = namespaceName(sid, v)
  }
  if (event.type === 'agent_spawn') {
    const original = typeof event.payload.name === 'string' ? event.payload.name : ''
    payload.displayName = payload.isMain === true && meta?.label ? meta.label : original
    payload.sessionId = sid
  }
  const start = meta?.startTime ?? baseMs
  return { ...event, payload, time: shiftTime(event.time, start, baseMs) }
}

/**
 * K-way merge of per-session event lists by time. Each list's own order is
 * preserved even if its times are not monotonic; ties go to the earlier list.
 */
export function mergeEventsByTime(lists: readonly (readonly SimulationEvent[])[]): SimulationEvent[] {
  const out: SimulationEvent[] = []
  const heads = lists.map(() => 0)
  for (;;) {
    let best = -1
    let bestTime = Infinity
    for (let i = 0; i < lists.length; i++) {
      if (heads[i] >= lists[i].length) continue
      const t = lists[i][heads[i]].time
      if (best === -1 || t < bestTime) { best = i; bestTime = t }
    }
    if (best === -1) break
    out.push(lists[best][heads[best]++])
  }
  return out
}
