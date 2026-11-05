import type { Agent } from '@/lib/agent-types'

export type AnchorAgent = Pick<Agent, 'id' | 'isMain' | 'parentId' | 'spawnTime'>

export interface Point { x: number; y: number }

/** Smallest centre-to-centre distance between neighbouring session clusters (world px). */
const MIN_CELL = 1000

/** Root (main) id of every agent, following parentId links. */
export function rootOf(agents: Iterable<AnchorAgent>): Map<string, string> {
  const byId = new Map<string, AnchorAgent>()
  for (const a of agents) byId.set(a.id, a)
  const roots = new Map<string, string>()
  for (const a of byId.values()) {
    let cur = a
    for (let i = 0; i < 64 && cur.parentId && byId.has(cur.parentId); i++) cur = byId.get(cur.parentId)!
    roots.set(a.id, cur.id)
  }
  return roots
}

/** Horizontal gutter added to a cell so tool/message bubbles (~200px each side) never reach the neighbour. */
const BUBBLE_GUTTER = 400
/** Default canvas aspect (width / height) when none is known. */
export const DEFAULT_ASPECT = 1.6

/**
 * Pick the column count whose grid shape best matches the viewport aspect,
 * with a small penalty for empty cells in the last row.
 */
export function chooseGrid(n: number, aspect: number, cellW: number, cellH: number): { cols: number; rows: number } {
  let best = { cols: 1, rows: n }
  let bestScore = Infinity
  for (let cols = 1; cols <= n; cols++) {
    const rows = Math.ceil(n / cols)
    const shape = (cols * cellW) / (rows * cellH)
    const score = Math.abs(Math.log(shape / aspect)) + (cols * rows - n) * 0.05
    if (score < bestScore - 1e-9) { bestScore = score; best = { cols, rows } }
  }
  return best
}

/**
 * Grid cell centres for each main agent when more than one main exists (the
 * All-sessions view); empty for a single main so single-session layout is
 * untouched. Cells are ordered by spawn time (then id) so indices stay stable
 * as sessions come and go. Cell size grows with the largest cluster, the grid
 * shape follows the viewport aspect, and every row is centred on its own count.
 */
export function computeMainAnchors(agents: Iterable<AnchorAgent>, aspect: number = DEFAULT_ASPECT): Map<string, Point> {
  const list = Array.from(agents)
  const mains = list.filter(a => a.isMain).sort((a, b) => a.spawnTime - b.spawnTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const anchors = new Map<string, Point>()
  if (mains.length < 2) return anchors

  const roots = rootOf(list)
  const sizes = new Map<string, number>()
  for (const r of roots.values()) sizes.set(r, (sizes.get(r) ?? 0) + 1)
  let biggest = 1
  for (const m of mains) biggest = Math.max(biggest, sizes.get(m.id) ?? 1)
  const cellH = MIN_CELL + 160 * Math.sqrt(biggest)
  const cellW = cellH + BUBBLE_GUTTER

  const n = mains.length
  const { cols, rows } = chooseGrid(n, aspect, cellW, cellH)
  mains.forEach((m, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    const inRow = Math.min(cols, n - row * cols)
    anchors.set(m.id, { x: (col - (inRow - 1) / 2) * cellW, y: (row - (rows - 1) / 2) * cellH })
  })
  return anchors
}

/**
 * Direction (radians) pointing away from the other sessions' mains, for
 * placing tool bubbles so they don't reach into neighbouring clusters.
 * Null outside the All view (no sessionId / fewer than 2 mains) or when the
 * agent's cluster sits at the centroid of the others.
 */
export function clusterOutwardAngle(
  agent: Pick<Agent, 'sessionId'>,
  agents: Iterable<Pick<Agent, 'isMain' | 'sessionId' | 'x' | 'y'>>,
): number | null {
  if (!agent.sessionId) return null
  let own: { x: number; y: number } | null = null
  let ox = 0, oy = 0, count = 0
  for (const a of agents) {
    if (!a.isMain) continue
    if (a.sessionId === agent.sessionId) { own = a; continue }
    ox += a.x; oy += a.y; count++
  }
  if (!own || count === 0) return null
  const dx = own.x - ox / count
  const dy = own.y - oy / count
  if (Math.hypot(dx, dy) < 1) return null
  return Math.atan2(dy, dx)
}

export interface ForceTarget extends Point { strength: number }

/** Per-node pull toward the owning main's cell: strong for mains, a gentle leash for sub-agents. */
export function computeForceTargets(agents: Iterable<AnchorAgent>, aspect: number = DEFAULT_ASPECT): Map<string, ForceTarget> {
  const list = Array.from(agents)
  const anchors = computeMainAnchors(list, aspect)
  const targets = new Map<string, ForceTarget>()
  if (anchors.size === 0) return targets
  const roots = rootOf(list)
  for (const a of list) {
    const anchor = anchors.get(roots.get(a.id) ?? a.id)
    if (anchor) targets.set(a.id, { ...anchor, strength: a.isMain ? 0.3 : 0.06 })
  }
  return targets
}
