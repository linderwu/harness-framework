import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { openStore } from '../../scripts/dsh/store.mjs'

async function withStore(fn) {
  const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-v1-'))
  const store = await openStore(root)
  try { return await fn(store, root) } finally { await store.close(); await rm(root, { recursive: true, force: true }) }
}

test('store preserves idempotency and events after close/reopen', async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-v1-reopen-'))
  const first = await openStore(root)
  await first.reserve('turn', 'request-1', { payloadHash: 'a', status: 'prepared' })
  await first.append('request-1', { seq: 1, type: 'text_delta', payload: { text: 'hello' } })
  await first.close()
  const second = await openStore(root)
  const replay = await second.reserve('turn', 'request-1', { payloadHash: 'a' })
  assert.equal(replay.created, false)
  assert.deepEqual((await second.readEvents('request-1')).events, [{ seq: 1, type: 'text_delta', payload: { text: 'hello' } }])
  await second.close()
  await rm(root, { recursive: true, force: true })
})

test('store rejects a second writer and conflicting request body', async () => {
  await withStore(async (store, root) => {
    await assert.rejects(openStore(root), { code: 'WRITER_OWNERSHIP_UNKNOWN' })
    await store.reserve('turn', 'request-1', { payloadHash: 'a' })
    await assert.rejects(store.reserve('turn', 'request-1', { payloadHash: 'b' }), { code: 'IDEMPOTENCY_CONFLICT' })
  })
})

test('store serializes concurrent patches and bounds event replay', async () => {
  await withStore(async (store) => {
    await store.reserve('turn', 'request-1', { payloadHash: 'a', status: 'prepared' })
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.patch('turn', 'request-1', { marker: index })))
    const record = await store.read('operations/turn', 'request-1')
    assert.equal(typeof record.marker, 'number')
    for (let seq = 1; seq <= 250; seq += 1) {
      await store.append('request-1', { seq, type: 'text_delta', payload: { text: 'x'.repeat(1200) } })
    }
    const page = await store.readEvents('request-1', 0)
    assert.equal(page.events.length <= 200, true)
    assert.equal(page.continuity, 'gap')
    assert.equal(page.hasMore, true)
  })
})
