import { test } from 'node:test'
import assert from 'node:assert'
import { deriveAgentType } from '../src/constants'

test('deriveAgentType', () => {
  assert.strictEqual(deriveAgentType(true), 'orchestrator')
  assert.strictEqual(deriveAgentType(false), 'subagent')
  assert.strictEqual(deriveAgentType(undefined), 'subagent')
})
