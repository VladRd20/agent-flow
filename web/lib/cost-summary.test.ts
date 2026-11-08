import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatCompactTokens, formatCostChip, formatCostUsd, costSummarySentence } from './cost-summary'

test('formatCompactTokens scales units', () => {
  assert.equal(formatCompactTokens(0), '0')
  assert.equal(formatCompactTokens(842), '842')
  assert.equal(formatCompactTokens(12_400), '12.4k')
  assert.equal(formatCompactTokens(250_000), '250k')
  assert.equal(formatCompactTokens(1_800_000), '1.8M')
  assert.equal(formatCompactTokens(NaN), '0')
})

test('formatCostUsd keeps precision for sub-cent amounts', () => {
  assert.equal(formatCostUsd(0), '$0.000')
  assert.equal(formatCostUsd(0.0042), '$0.0042')
  assert.equal(formatCostUsd(0.4123), '$0.412')
})

test('chip and sentence', () => {
  assert.equal(formatCostChip(0.4123, 1_800_000), '$0.412 · 1.8M tok')
  assert.equal(costSummarySentence(0.4123, 1_800_000), 'Total session cost about $0.412, 1.8M tokens')
})

test('cost total tooltip states the total never decreases', async () => {
  const { COST_TOTAL_TOOLTIP } = await import('./cost-summary')
  assert.match(COST_TOTAL_TOOLTIP, /never decreases/)
  assert.match(costSummarySentence(1, 1000), /^Total session cost/)
})
