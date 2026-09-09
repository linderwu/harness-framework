import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCapabilities, capabilityFlags } from '../../scripts/dsh/capabilities.mjs'

test('unobserved capabilities remain unavailable', () => {
  const result = capabilityFlags({ interrupt: true })
  assert.equal(result.interrupt, true)
  assert.equal(result.sessionResume, false)
  assert.equal(result.inputBudget, false)
})

test('capabilities identify host and bounded transport', () => {
  const result = buildCapabilities({ hostId: 'B', agents: [{ agentId: 'codex', capabilities: { events: true } }], observedAt: 'fixture' })
  assert.equal(result.hostId, 'B')
  assert.equal(result.agents[0].capabilities.events, true)
  assert.equal(result.limits.maxRequestBytes, 1048576)
})
