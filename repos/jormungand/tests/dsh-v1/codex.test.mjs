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
    events: [{ sequence: 1, type: 'assistant_delta', turnId: 'turn-1', payload: { delta: 'ok' } }],
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
  const events = await adapter.readEvents({ requestId: 'r1', bindingKey: 'b', target: {}, afterSeq: 0, nativeSessionId: 'thread-1', nativeRunId: 'turn-1' })
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


test('Codex adapter requires native thread identity for start and interrupt', async () => {
  const starts = []
  const interrupts = []
  const session = {
    threadId: 'thread-native',
    currentTurnId: 'turn-native',
    turnStatus: 'inProgress',
    startTurn: async (message, options) => {
      starts.push({ message, options })
      return { id: 'turn-native', status: 'inProgress' }
    },
    interrupt: async nativeRunId => {
      interrupts.push(nativeRunId)
      return true
    },
  }
  const adapter = createCodexAdapter({ sessionFor: async () => session })
  const ensured = await adapter.ensureSession({ bindingKey: 'identity', target: {} })
  assert.equal(ensured.nativeSessionId, 'thread-native')

  const staleStart = await adapter.startTurn({
    requestId: 'stale-start', bindingKey: 'identity', nativeSessionId: 'thread-stale', target: {}, message: 'work',
  })
  assert.equal(staleStart.status, 'unknown')
  assert.equal(starts.length, 0)

  const started = await adapter.startTurn({
    requestId: 'native-start', bindingKey: 'identity', nativeSessionId: 'thread-native', target: {}, message: 'work',
  })
  assert.deepEqual({ nativeSessionId: started.nativeSessionId, nativeRunId: started.nativeRunId, status: started.status }, {
    nativeSessionId: 'thread-native', nativeRunId: 'turn-native', status: 'running',
  })

  const staleInterrupt = await adapter.interruptTurn({
    requestId: 'stale-interrupt', bindingKey: 'identity', nativeSessionId: 'thread-stale', nativeRunId: 'turn-native', target: {},
  })
  assert.equal(staleInterrupt.accepted, false)
  assert.equal(staleInterrupt.turn.status, 'unknown')
  assert.deepEqual(interrupts, [])

  const interrupted = await adapter.interruptTurn({
    requestId: 'native-interrupt', bindingKey: 'identity', nativeSessionId: 'thread-native', nativeRunId: 'turn-native', target: {},
  })
  assert.equal(interrupted.accepted, true)
  assert.equal(interrupted.turn.status, 'stopping')
  assert.deepEqual(interrupts, ['turn-native'])
})

test('Codex adapter validates the selected effort against the native model catalog', async () => {
  let started = 0
  const session = {
    threadId: 'thread-model',
    startTurn: async () => {
      started += 1
      return { id: 'turn-model', status: 'inProgress' }
    },
  }
  const adapter = createCodexAdapter({
    sessionFor: async () => session,
    models: async () => ({ models: [{ id: 'allowed', supportedReasoningEfforts: ['low', 'high'] }] }),
  })
  await adapter.ensureSession({ bindingKey: 'model-effort', target: {} })

  await assert.rejects(adapter.startTurn({
    requestId: 'unsupported-effort', bindingKey: 'model-effort', nativeSessionId: 'thread-model',
    target: { modelId: 'allowed', reasoningEffort: 'medium' }, message: 'work',
  }), { code: 'INVALID_REASONING_EFFORT' })
  assert.equal(started, 0)

  const startedTurn = await adapter.startTurn({
    requestId: 'supported-effort', bindingKey: 'model-effort', nativeSessionId: 'thread-model',
    target: { modelId: 'allowed', reasoningEffort: 'high' }, message: 'work',
  })
  assert.equal(startedTurn.status, 'running')
  assert.equal(started, 1)
})

test('Codex adapter filters replayed events by native run and returns the native cursor', async () => {
  const session = {
    threadId: 'thread-events',
    sequence: 4,
    events: [
      { sequence: 1, type: 'session_ready', message: 'ready' },
      { sequence: 2, type: 'assistant_delta', turnId: 'turn-one', text: 'hello', message: 'hello' },
      { sequence: 3, type: 'assistant_delta', turnId: 'turn-two', text: 'wrong turn', message: 'wrong turn' },
      { sequence: 4, type: 'turn_completed', turnId: 'turn-one', text: 'done', message: 'done' },
    ],
    turnStatus: 'completed',
    currentTurnId: 'turn-one',
    finalText: 'done',
  }
  const adapter = createCodexAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'events', target: {} })
  const page = await adapter.readEvents({
    requestId: 'events-run', bindingKey: 'events', target: {}, nativeSessionId: 'thread-events', nativeRunId: 'turn-one', afterSeq: 0,
  })
  assert.deepEqual(page.events.map(event => event.seq), [1, 2])
  assert.equal(page.events[0].payload.text, 'hello')
  assert.equal(page.events[0].payload.nativeRunId, 'turn-one')
  assert.deepEqual({
    nativeSessionId: page.turn.nativeSessionId,
    nativeRunId: page.turn.nativeRunId,
    lastEventSeq: page.turn.lastEventSeq,
    status: page.turn.status,
  }, { nativeSessionId: 'thread-events', nativeRunId: 'turn-one', lastEventSeq: 2, status: 'completed' })

  const stale = await adapter.getTurn({
    requestId: 'events-run', bindingKey: 'events', target: {}, nativeSessionId: 'thread-events', nativeRunId: 'turn-two',
  })
  assert.equal(stale.status, 'unknown')
  const staleEvents = await adapter.readEvents({
    requestId: 'events-run', bindingKey: 'events', target: {}, nativeSessionId: 'thread-events', nativeRunId: 'turn-two', afterSeq: 0,
  })
  assert.deepEqual(staleEvents.events, [])
  assert.equal(staleEvents.turn.status, 'unknown')
})

test('Codex adapter preserves unknown outcomes when native acceptance is ambiguous', async () => {
  const session = {
    threadId: 'thread-unknown',
    sequence: 7,
    startTurn: async () => { throw Object.assign(new Error('transport ended'), { code: 'NATIVE_TIMEOUT' }) },
    interrupt: async () => { throw Object.assign(new Error('transport ended'), { code: 'NATIVE_TIMEOUT' }) },
  }
  const adapter = createCodexAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'unknown', target: {} })

  const turn = await adapter.startTurn({
    requestId: 'unknown-start', bindingKey: 'unknown', nativeSessionId: 'thread-unknown', target: {}, message: 'work',
  })
  assert.deepEqual({ nativeSessionId: turn.nativeSessionId, nativeRunId: turn.nativeRunId, status: turn.status, lastEventSeq: turn.lastEventSeq }, {
    nativeSessionId: 'thread-unknown', nativeRunId: null, status: 'unknown', lastEventSeq: 0,
  })

  const interrupted = await adapter.interruptTurn({
    requestId: 'unknown-interrupt', bindingKey: 'unknown', nativeSessionId: 'thread-unknown', nativeRunId: 'turn-unknown', target: {},
  })
  assert.equal(interrupted.accepted, false)
  assert.equal(interrupted.turn.status, 'unknown')
})

test('Codex adapter does not turn an unrecognized native status into running', async () => {
  const session = {
    threadId: 'thread-status',
    startTurn: async () => ({ id: 'turn-status', status: 'futureNativeState' }),
  }
  const adapter = createCodexAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'status', target: {} })
  const turn = await adapter.startTurn({
    requestId: 'status-run', bindingKey: 'status', nativeSessionId: 'thread-status', target: {}, message: 'work',
  })
  assert.equal(turn.status, 'unknown')
})

test('Codex adapter retains the native run identity when the session wrapper omits currentTurnId', async () => {
  const interrupts = []
  const session = {
    threadId: 'thread-run-memory',
    startTurn: async () => ({ id: 'turn-run-memory', status: 'inProgress' }),
    interrupt: async nativeRunId => { interrupts.push(nativeRunId); return true },
  }
  const adapter = createCodexAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'run-memory', target: {} })
  await adapter.startTurn({
    requestId: 'run-memory-start', bindingKey: 'run-memory', nativeSessionId: 'thread-run-memory', target: {}, message: 'work',
  })
  const interrupted = await adapter.interruptTurn({
    requestId: 'run-memory-interrupt', bindingKey: 'run-memory', nativeSessionId: 'thread-run-memory', nativeRunId: 'turn-run-memory', target: {},
  })
  assert.equal(interrupted.accepted, true)
  assert.deepEqual(interrupts, ['turn-run-memory'])
})

test('Codex adapter refuses to start without the exact native session identity', async () => {
  let starts = 0
  const session = { threadId: 'thread-required', startTurn: async () => { starts += 1; return { id: 'run-1', status: 'inProgress' } } }
  const adapter = createCodexAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'required', target: {} })
  const result = await adapter.startTurn({ requestId: 'missing-session', bindingKey: 'required', target: {}, message: 'work' })
  assert.equal(result.status, 'unknown')
  assert.equal(starts, 0)
})

test('Codex adapter requires an explicit boolean interrupt acknowledgement', async () => {
  const session = {
    threadId: 'thread-ack', currentTurnId: 'run-ack', turnStatus: 'inProgress',
    interrupt: async () => undefined,
  }
  const adapter = createCodexAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'ack', target: {} })
  const result = await adapter.interruptTurn({ requestId: 'ack', bindingKey: 'ack', target: {}, nativeSessionId: 'thread-ack', nativeRunId: 'run-ack' })
  assert.equal(result.accepted, false)
  assert.equal(result.turn.status, 'unknown')
})

test('Codex adapter preserves the provided event page contract', async () => {
  const nativePage = {
    events: [{ seq: 2, type: 'custom', payload: { nativeRunId: 'turn-contract', value: 'keep-exactly' } }],
    turn: { requestId: 'events-contract', nativeSessionId: 'thread-contract', nativeRunId: 'turn-contract', status: 'running', lastEventSeq: 2 },
  }
  let received
  const session = { threadId: 'thread-contract', currentTurnId: 'turn-contract', turnStatus: 'inProgress' }
  const adapter = createCodexAdapter({
    sessionFor: async () => session,
    events: async input => { received = input; return nativePage },
  })
  await adapter.ensureSession({ bindingKey: 'events-contract', target: {} })
  const page = await adapter.readEvents({
    requestId: 'events-contract', bindingKey: 'events-contract', target: {}, nativeSessionId: 'thread-contract', nativeRunId: 'turn-contract', afterSeq: 0,
  })
  assert.deepEqual(page.events, [{ seq: 1, type: 'custom', payload: { nativeRunId: 'turn-contract', value: 'keep-exactly', nativeSeq: 2, nativeType: 'custom' } }])
  assert.equal(page.turn.lastEventSeq, 1)
  assert.equal(received.afterSeq, 0)
  assert.equal(received.nativeRunId, 'turn-contract')
})

test('Codex adapter filters custom event pages without rewriting their payloads', async () => {
  const page = {
    events: [
      { seq: 2, type: 'custom', payload: { nativeRunId: 'turn-contract', value: 'keep' } },
      { seq: 3, type: 'custom', payload: { nativeRunId: 'other-turn', value: 'drop' } },
    ],
    turn: { requestId: 'events-filter', nativeSessionId: 'thread-filter', nativeRunId: 'turn-contract', status: 'running', lastEventSeq: 3 },
  }
  const session = { threadId: 'thread-filter', currentTurnId: 'turn-contract', turnStatus: 'inProgress' }
  const adapter = createCodexAdapter({ sessionFor: async () => session, events: async () => page })
  await adapter.ensureSession({ bindingKey: 'events-filter', target: {} })
  const result = await adapter.readEvents({
    requestId: 'events-filter', bindingKey: 'events-filter', target: {}, nativeSessionId: 'thread-filter', nativeRunId: 'turn-contract', afterSeq: 0,
  })
  assert.deepEqual(result.events, [{ seq: 1, type: 'custom', payload: { nativeRunId: 'turn-contract', value: 'keep', nativeSeq: 2, nativeType: 'custom' } }])
})
