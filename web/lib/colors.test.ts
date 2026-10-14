import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { getModelFamily, getAgentGroupColor, COLORS } from './colors'

test('getModelFamily recognizes Claude family names', () => {
  assert.equal(getModelFamily('claude-sonnet-4-5-20250929'), 'sonnet')
  assert.equal(getModelFamily('claude-opus-4-1-20250805'), 'opus')
  assert.equal(getModelFamily('claude-haiku-4-5-20251001'), 'haiku')
})

test('getModelFamily recognizes gpt/codex models', () => {
  assert.equal(getModelFamily('gpt-5-codex'), 'gpt')
})

test('getModelFamily returns null for unknown/missing model', () => {
  assert.equal(getModelFamily(undefined), null)
  assert.equal(getModelFamily('some-unknown-model'), null)
})

test('getAgentGroupColor prefers model family color when known', () => {
  assert.equal(getAgentGroupColor({ isMain: false, model: 'claude-opus-4-1-20250805' }), COLORS.familyOpus)
  assert.equal(getAgentGroupColor({ isMain: true, model: 'claude-sonnet-4-5-20250929' }), COLORS.familySonnet)
})

test('getAgentGroupColor falls back to category color when model is unknown', () => {
  assert.equal(getAgentGroupColor({ isMain: true }), COLORS.categoryOrchestrator)
  assert.equal(getAgentGroupColor({ isMain: false }), COLORS.categorySubagent)
})
