import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { openStore } from '../../scripts/dsh/store.mjs'
import { createEthernetRepair } from '../../scripts/dsh/host-actions/ethernet.mjs'

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-ethernet-'))
  const store = await openStore(root)
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  return { store, ...options }
}

test('same request executes Ethernet repair once and replays the receipt', async t => {
  const { store } = await fixture(t)
  let executions = 0
  const repair = createEthernetRepair({
    store,
    inspect: async () => ({ kind: 'ethernet', interfaceName: 'fixture-lan', index: 7, internetRouteUsesTarget: false }),
    execute: async () => { executions += 1; return { status: 'completed', downAttempted: true, upAttempted: true } },
  })
  const first = await repair.request({ requestId: 'same', hostId: 'A' })
  const second = await repair.request({ requestId: 'same', hostId: 'A' })
  assert.equal(first.status, 'completed')
  assert.deepEqual(second, first)
  assert.equal(executions, 1)
})

test('default-route Ethernet is rejected before execution', async t => {
  const { store } = await fixture(t)
  let executions = 0
  const repair = createEthernetRepair({
    store,
    inspect: async () => ({ kind: 'ethernet', interfaceName: 'fixture-lan', mac: '00:11:22:33:44:55', internetRouteUsesTarget: true }),
    execute: async () => { executions += 1; return { status: 'completed' } },
  })
  const result = await repair.request({ requestId: 'default-route', hostId: 'A' })
  assert.equal(result.status, 'rejected')
  assert.equal(result.error, 'ETHERNET_IS_DEFAULT_ROUTE')
  assert.equal(executions, 0)
})

test('executor uncertainty remains unknown and records recovery state', async t => {
  const { store } = await fixture(t)
  const repair = createEthernetRepair({
    store,
    inspect: async () => ({ kind: 'ethernet', interfaceName: 'fixture-lan', mac: '00:11:22:33:44:55', internetRouteUsesTarget: false }),
    execute: async () => { throw Object.assign(new Error('up failed'), { code: 'UP_FAILED' }) },
  })
  const result = await repair.request({ requestId: 'unknown', hostId: 'A' })
  assert.equal(result.status, 'unknown')
  assert.equal(result.error, 'UP_FAILED')
})

test('host B cannot invoke the A-only repair', async t => {
  const { store } = await fixture(t)
  const repair = createEthernetRepair({
    store,
    inspect: async () => ({}),
    execute: async () => ({ status: 'completed' }),
  })
  await assert.rejects(repair.request({ requestId: 'wrong-host', hostId: 'B' }), { code: 'UNKNOWN_HOST' })
})
