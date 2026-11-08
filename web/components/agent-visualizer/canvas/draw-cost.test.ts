import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createUsageLedger } from '@/hooks/simulation/usage-ledger'
import type { Agent } from '@/lib/agent-types'
import { ledgerBreakdown } from './draw-cost'

function ledgerWith(entries: Array<[string, { name: string; isMain?: boolean; model?: string; tokens: number }]>) {
  const l = createUsageLedger()
  for (const [id, e] of entries) l.agents.set(id, { name: e.name, isMain: !!e.isMain, model: e.model, tokens: e.tokens })
  return l
}
const live = (m: Record<string, string>) =>
  new Map(Object.entries(m).map(([id, state]) => [id, { id, state } as unknown as Agent]))

test('without live agents every ledger entry is a row and nothing is folded when under the cap', () => {
  const b = ledgerBreakdown(ledgerWith([['a', { name: 'main', isMain: true, tokens: 1000 }]]))
  assert.equal(b.rows.length, 1)
  assert.equal(b.rest, null)
})

test('removed agents fold into one reconciling row so rows sum to the total', () => {
  const l = ledgerWith([
    ['m', { name: 'main', isMain: true, model: 'claude-opus-4-7', tokens: 500_000 }],
    ['s1', { name: 'sub1', model: 'claude-sonnet-4-6', tokens: 200_000 }],
    ['gone', { name: 'old', model: 'claude-haiku-4-5', tokens: 300_000 }],
  ])
  const b = ledgerBreakdown(l, live({ m: 'thinking', s1: 'complete' }))
  assert.deepEqual(b.rows.map(r => [r.id, r.status]), [['m', 'running'], ['s1', 'complete']])
  assert.equal(b.rest?.label, 'Finished/removed agents')
  assert.equal(b.rest?.count, 1)
  const sum = b.rows.reduce((s, r) => s + r.cost, 0) + (b.rest?.cost ?? 0)
  assert.ok(Math.abs(sum - b.totalCost) < 1e-9)
})

test('running agents sort before finished ones; overflow joins the reconciling row', () => {
  const l = ledgerWith([
    ['done', { name: 'done', tokens: 9_000_000 }],
    ['r1', { name: 'r1', tokens: 100 }],
    ['r2', { name: 'r2', tokens: 200 }],
  ])
  const b = ledgerBreakdown(l, live({ done: 'complete', r1: 'tool_calling', r2: 'thinking' }), 2)
  assert.deepEqual(b.rows.map(r => r.id), ['r2', 'r1'])
  assert.equal(b.rest?.label, 'Other + finished agents')
  assert.equal(b.rest?.count, 1)
})
