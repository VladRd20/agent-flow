import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { buildForceConfig } from './force-config'
import type { Agent, Edge } from '@/lib/agent-types'

const ag = (id: string, isMain = false) => ({ id, isMain } as Agent)

test('buildForceConfig scales repulsion/links with node count and sizes collide radius per node', () => {
  const small = buildForceConfig(new Map([['m', ag('m', true)]]), [])
  const agents = new Map<string, Agent>([['m', ag('m', true)]])
  const edges: Edge[] = []
  for (let i = 0; i < 12; i++) {
    agents.set(`s${i}`, ag(`s${i}`))
    edges.push({ id: `e${i}`, from: 'm', to: `s${i}`, type: 'parent-child' } as Edge)
  }
  const big = buildForceConfig(agents, edges)
  assert.ok(big.chargeStrength < small.chargeStrength)
  assert.ok(big.linkDistance > small.linkDistance)
  assert.ok(big.radii.get('m')! >= big.radii.get('s0')!, 'hub is at least as large as a leaf')
  assert.equal(big.radii.size, 13)
})
