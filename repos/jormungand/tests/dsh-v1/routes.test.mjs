import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { openStore } from '../../scripts/dsh/store.mjs'
import { createDshService } from '../../scripts/dsh/service.mjs'
import { createDshV1Handler } from '../../scripts/dsh/routes.mjs'
import { createDshBridgeV1 } from '../../scripts/dsh/bridge-v1.mjs'

async function withServer(fn) {
  const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-route-'))
  const store = await openStore(root)
  const service = createDshService({
    store,
    registry: [{ hostId: 'B', agentId: 'codex', capabilities: { events: true }, adapter: {
      async ensureSession() { return { bindingKey: 'binding-1', status: 'ready', nativeSessionId: 'session-1' } },
      async startTurn(input) { return { requestId: input.requestId, nativeSessionId: input.nativeSessionId, nativeRunId: 'run-1', status: 'running', lastEventSeq: 0 } },
      async interruptTurn(input) { return { requestId: input.requestId, accepted: true, turn: { requestId: input.requestId, nativeSessionId: input.nativeSessionId, nativeRunId: input.nativeRunId, status: 'stopping', lastEventSeq: 0 } } },
      async listModels() { return { models: [{ id: 'fixture-model' }], observedAt: 'fixture' } },
    } }],
  })
  const handler = createDshV1Handler({ service, authenticate: request => request.headers.authorization === 'Bearer fixture-token' })
  const server = createServer(async (request, response) => {
    const handled = await handler(request, response, new URL(request.url, 'http://127.0.0.1'))
    if (!handled) { response.writeHead(404); response.end() }
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  try { return await fn(`http://127.0.0.1:${server.address().port}`) } finally { await new Promise(resolveClose => server.close(resolveClose)); await store.close(); await rm(root, { recursive: true, force: true }) }
}

test('v1 routes authenticate, reserve once, and recover a turn', async () => {
  await withServer(async origin => {
    const headers = { authorization: 'Bearer fixture-token', 'content-type': 'application/json' }
    const target = { agentId: 'codex', hostId: 'B', workspaceId: 'ws' }
    const session = await fetch(`${origin}/dsh/v1/sessions`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'session-1', bindingKey: 'binding-1', target }) })
    assert.equal(session.status, 201)
    const body = await fetch(`${origin}/dsh/v1/turns`, { method: 'POST', headers, body: JSON.stringify({ requestId: 'turn-1', bindingKey: 'binding-1', nativeSessionId: 'session-1', target, message: 'work', handoff: null, attachments: [] }) })
    assert.equal(body.status, 202)
    assert.equal((await body.json()).nativeRunId, 'run-1')
    const replay = await fetch(`${origin}/dsh/v1/turns/by-request/turn-1`, { headers: { authorization: 'Bearer fixture-token' } })
    assert.equal(replay.status, 200)
  })
})

test('v1 routes never expose unauthorized native calls', async () => {
  await withServer(async origin => {
    const response = await fetch(`${origin}/dsh/v1/capabilities`)
    assert.equal(response.status, 401)
    assert.equal((await response.json()).error.code, 'UNAUTHORIZED')
  })
})

test('v1 bridge refuses to mount without an explicit token', async () => {
  const root = await mkdtemp(join(resolve(tmpdir()), 'dsh-token-'))
  await assert.rejects(createDshBridgeV1({ hostId: 'B', registry: [], storeRoot: root }), { code: 'BRIDGE_TOKEN_REQUIRED' })
  await rm(root, { recursive: true, force: true })
})
