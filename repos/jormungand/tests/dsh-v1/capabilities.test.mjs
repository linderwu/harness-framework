import assert from 'node:assert/strict'
import test from 'node:test'
import { buildCapabilities, capabilityFlags } from '../../scripts/dsh/capabilities.mjs'
import { createDshService } from '../../scripts/dsh/service.mjs'
import { openStore } from '../../scripts/dsh/store.mjs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('service projects observed adapter capabilities when registry metadata is omitted', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-v1-capabilities-'))
  const store = await openStore(root)
  try {
    const service = createDshService({
      store,
      registry: [{
        agentId: 'codex',
        hostId: 'B',
        runtimeKind: 'codex-app-server',
        runtimeVersion: 'fixture',
        adapter: { capabilities: { events: true, interrupt: true } },
      }],
    })
    const result = await service.getCapabilities()
    assert.equal(result.agents[0].capabilities.events, true)
    assert.equal(result.agents[0].capabilities.interrupt, true)
    assert.deepEqual(result.agents[0].runtime, { kind: 'codex-app-server', version: 'fixture' })
  } finally {
    await store.close()
    await rm(root, { recursive: true, force: true })
  }
})
