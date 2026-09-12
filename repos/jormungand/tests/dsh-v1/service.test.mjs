import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { openStore } from '../../scripts/dsh/store.mjs'
import { createDshService } from '../../scripts/dsh/service.mjs'


test('getTurn enriches a terminal receipt when the status is unchanged', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-service-terminal-output-'))
  const store = await openStore(root)
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })
  const service = createDshService({
    store,
    registry: [{
      agentId: 'codex',
      hostId: 'B',
      adapter: {
        capabilities: { events: true },
        ensureSession: async () => ({ status: 'ready', nativeSessionId: 'native-1' }),
        startTurn: async () => ({ nativeSessionId: 'native-1', nativeRunId: 'run-1', status: 'completed' }),
        getTurn: async () => ({ nativeSessionId: 'native-1', nativeRunId: 'run-1', status: 'completed', output: 'authoritative output' }),
      },
    }],
  })
  const target = { agentId: 'codex', hostId: 'B', workspaceId: 'repo' }
  await service.ensureSession({ bindingKey: 'binding', requestId: 'session', target })
  const started = await service.startTurn({ requestId: 'turn', bindingKey: 'binding', nativeSessionId: 'native-1', target, message: 'work', handoff: null })
  assert.equal(started.output, undefined)
  const observed = await service.getTurn({ requestId: 'turn' })
  assert.equal(observed.status, 'completed')
  assert.equal(observed.output, 'authoritative output')
})

test('concurrent ensureSession calls reserve once and do not duplicate adapter work', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-service-session-'))
  const store = await openStore(root)
  t.after(async () => { await store.close(); await rm(root, { recursive: true, force: true }) })

  let ensureCalls = 0
  let releaseEnsure
  const ensureBarrier = new Promise((resolve) => { releaseEnsure = resolve })
  const service = createDshService({
    store,
    registry: [{
      agentId: 'codex',
      hostId: 'B',
      adapter: {
        async ensureSession() {
          ensureCalls += 1
          await ensureBarrier
          return { bindingKey: 'codex-B-repo', status: 'ready', nativeSessionId: 'native-1' }
        },
      },
    }],
  })

  const first = service.ensureSession({
    bindingKey: 'codex-B-repo',
    requestId: 'session-1',
    target: { agentId: 'codex', hostId: 'B', workspaceId: 'repo' },
  })
  await new Promise((resolve) => setImmediate(resolve))
  const second = await service.ensureSession({
    bindingKey: 'codex-B-repo',
    requestId: 'session-1',
    target: { agentId: 'codex', hostId: 'B', workspaceId: 'repo' },
  })

  assert.equal(ensureCalls, 1)
  assert.equal(second.status, 'prepared')
  releaseEnsure()
  assert.equal((await first).status, 'ready')
})
