import type { Agent } from '@/lib/agent-types'

export type AnchorAgent = Pick<Agent, 'id' | 'isMain' | 'parentId' | 'spawnTime'>

export interface Point { x: number; y: number }

/** Smallest centre-to-centre distance between neighbouring session clusters (world px). */
const MIN_CELL = 900

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

/**
 * Grid cell centres for each main agent when more than one main exists (the
 * All-sessions view); empty for a single main so single-session layout is
 * untouched. Cells are ordered by spawn time (then id) so indices stay stable
 * as sessions come and go. Cell size grows with the largest cluster.
 */
export function computeMainAnchors(agents: Iterable<AnchorAgent>): Map<string, Point> {
  const list = Array.from(agents)
  const mains = list.filter(a => a.isMain).sort((a, b) => a.spawnTime - b.spawnTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const anchors = new Map<string, Point>()
  if (mains.length < 2) return anchors

  const roots = rootOf(list)
  const sizes = new Map<string, number>()
  for (const r of roots.values()) sizes.set(r, (sizes.get(r) ?? 0) + 1)
  let biggest = 1
  for (const m of mains) biggest = Math.max(biggest, sizes.get(m.id) ?? 1)
  const cell = MIN_CELL + 140 * Math.sqrt(biggest)

  const n = mains.length
  const cols = Math.ceil(Math.sqrt(n * 1.6))
  const rows = Math.ceil(n / cols)
  mains.forEach((m, i) => {
    const col = i % cols
    const row = Math.floor(i / cols)
    anchors.set(m.id, { x: (col - (cols - 1) / 2) * cell * 1.25, y: (row - (rows - 1) / 2) * cell })
  })
  return anchors
}

export interface ForceTarget extends Point { strength: number }

/** Per-node pull toward the owning main's cell: strong for mains, a gentle leash for sub-agents. */
export function computeForceTargets(agents: Iterable<AnchorAgent>): Map<string, ForceTarget> {
  const list = Array.from(agents)
  const anchors = computeMainAnchors(list)
  const targets = new Map<string, ForceTarget>()
  if (anchors.size === 0) return targets
  const roots = rootOf(list)
  for (const a of list) {
    const anchor = anchors.get(roots.get(a.id) ?? a.id)
    if (anchor) targets.set(a.id, { ...anchor, strength: a.isMain ? 0.3 : 0.02 })
  }
  return targets
}
