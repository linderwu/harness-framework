import assert from 'node:assert/strict'
import test from 'node:test'
import { createCodexAdapter } from '../../scripts/dsh/codex.mjs'
import { createCodexAppServerSession } from '../../scripts/codex-app-server-session.mjs'

test('Codex session sends selected model and effort per turn', async () => {
  const calls = []
  const session = createCodexAppServerSession({
    threadId: 'thread-1',
    workspacePath: '/workspace',
    request: async (method, params) => {
      calls.push({ method, params })
      if (method === 'initialize') return {}
      if (method === 'turn/start') return { turn: { id: 'turn-1', status: 'inProgress' } }
      return { thread: { id: 'thread-1' } }
    },
  })
  await session.start()
  await session.startTurn('continue', { modelId: 'fixture-model', reasoningEffort: 'high' })
  const turn = calls.find(item => item.method === 'turn/start').params
  assert.equal(turn.model, 'fixture-model')
  assert.equal(turn.effort, 'high')
})

test('Codex adapter forwards handoff and attachments and can replay session events', async () => {
  const calls = []
  const session = {
    threadId: 'thread-1',
    events: [{ sequence: 1, type: 'assistant_delta', payload: { delta: 'ok' } }],
    turnStatus: 'completed',
    currentTurnId: 'turn-1',
    finalText: 'ok',
    startTurn: async (message, options) => {
      calls.push({ message, options })
      return { id: 'turn-1', status: 'inProgress' }
    },
    interrupt: async () => undefined,
  }
  const adapter = createCodexAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'b', target: {} })
  await adapter.startTurn({
    requestId: 'r1', bindingKey: 'b', nativeSessionId: 'thread-1',
    target: { modelId: 'fixture-model', reasoningEffort: 'high' },
    message: 'continue', handoff: { version: 1, messages: [{ id: 'u1', text: 'prior' }] }, attachments: [{ reference: 'a1' }],
  })
  assert.match(calls[0].message, /DSH handoff context/)
  assert.match(calls[0].message, /prior/)
  assert.deepEqual(calls[0].options.handoff, { version: 1, messages: [{ id: 'u1', text: 'prior' }] })
  assert.deepEqual(calls[0].options.attachments, [{ reference: 'a1' }])
  const events = await adapter.readEvents({ requestId: 'r1', bindingKey: 'b', target: {}, afterSeq: 0, nativeRunId: 'turn-1' })
  assert.equal(events.events[0].type, 'assistant_delta')
  assert.equal((await adapter.getTurn({ requestId: 'r1', bindingKey: 'b', target: {}, nativeRunId: 'turn-1', nativeSessionId: 'thread-1' })).status, 'completed')
})

test('Codex adapter rejects a model outside the observed native catalog before writing', async () => {
  let started = false
  const adapter = createCodexAdapter({
    sessionFor: async () => ({ startTurn: async () => { started = true; return { id: 'r' } } }),
    models: async () => ({ models: [{ id: 'allowed' }] }),
  })
  await adapter.ensureSession({ bindingKey: 'model', target: {} })
  await assert.rejects(adapter.startTurn({ requestId: 'model-run', bindingKey: 'model', target: { modelId: 'blocked' }, message: 'work' }), { code: 'INVALID_MODEL' })
  assert.equal(started, false)
})
