import assert from 'node:assert/strict'
import test from 'node:test'

import { buildOpenClawAgentMap, createOpenClawAdapter } from '../../scripts/dsh/openclaw.mjs'

function target(agentId = 'openclaw.rowlet') {
  return { agentId, hostId: 'B', workspaceId: 'repo' }
}

test('OpenClaw maps the explicit Harness agent and role before session resolution', async () => {
  const calls = []
  const session = { nativeSessionId: 'session-rowlet' }
  const adapter = createOpenClawAdapter({
    agentMap: {
      'openclaw.rowlet': { mainAgent: 'rowlet', role: 'worker' },
    },
    sessionFor: async input => {
      calls.push(input)
      return session
    },
  })

  const result = await adapter.ensureSession({ bindingKey: 'rowlet-B-repo', target: target() })

  assert.equal(result.status, 'ready')
  assert.equal(calls[0].target.agentId, 'rowlet')
  assert.equal(calls[0].target.dshAgentId, 'openclaw.rowlet')
  assert.equal(calls[0].target.mainAgent, 'rowlet')
  assert.equal(calls[0].target.role, 'worker')
})

test('OpenClaw preserves exact session and run identity across start and observation', async () => {
  const observations = []
  const session = {
    nativeSessionId: 'session-rowlet',
    async startTurn(message, input) {
      observations.push({ kind: 'start', message, input })
      return { sessionId: 'session-rowlet', runId: 'run-1', status: 'running', lastEventSeq: 3 }
    },
    async getTurn(input) {
      observations.push({ kind: 'observe', input })
      return { sessionId: 'session-rowlet', runId: 'run-1', status: 'completed', lastEventSeq: 4, output: 'done' }
    },
  }
  const adapter = createOpenClawAdapter({
    agentMap: { 'openclaw.rowlet': { mainAgent: 'rowlet', role: 'worker' } },
    sessionFor: async () => session,
  })
  await adapter.ensureSession({ bindingKey: 'identity', target: target() })

  const started = await adapter.startTurn({
    requestId: 'request-1',
    bindingKey: 'identity',
    nativeSessionId: 'session-rowlet',
    target: target(),
    message: 'work',
  })
  const observed = await adapter.getTurn({
    requestId: 'request-1',
    bindingKey: 'identity',
    nativeSessionId: 'session-rowlet',
    nativeRunId: 'run-1',
    target: target(),
  })

  assert.deepEqual(started, {
    requestId: 'request-1',
    nativeSessionId: 'session-rowlet',
    nativeRunId: 'run-1',
    status: 'running',
    lastEventSeq: 3,
  })
  assert.equal(observed.status, 'completed')
  assert.equal(observed.nativeSessionId, 'session-rowlet')
  assert.equal(observed.nativeRunId, 'run-1')
  assert.equal(observed.output, 'done')
  assert.equal(observations[0].input.mainAgent, 'rowlet')
  assert.equal(observations[0].input.role, 'worker')
  assert.equal(observations[1].input.nativeRunId, 'run-1')
})

test('OpenClaw rejects a native session or run observation with stale identity', async () => {
  const session = {
    nativeSessionId: 'session-rowlet',
    async startTurn() {
      return { sessionId: 'session-other', runId: 'run-1', status: 'running' }
    },
    async getTurn() {
      return { sessionId: 'session-rowlet', runId: 'run-old', status: 'completed' }
    },
  }
  const adapter = createOpenClawAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'stale', target: target('openclaw') })

  const started = await adapter.startTurn({
    requestId: 'stale-start',
    bindingKey: 'stale',
    nativeSessionId: 'session-rowlet',
    target: target('openclaw'),
    message: 'work',
  })
  const observed = await adapter.getTurn({
    requestId: 'stale-observe',
    bindingKey: 'stale',
    nativeSessionId: 'session-rowlet',
    nativeRunId: 'run-1',
    target: target('openclaw'),
  })

  assert.equal(started.status, 'unknown')
  assert.equal(started.nativeSessionId, 'session-rowlet')
  assert.equal(started.nativeRunId, null)
  assert.equal(observed.status, 'unknown')
  assert.equal(observed.nativeRunId, 'run-1')
})

test('OpenClaw reports a running acknowledgement until an authentic terminal observation', async () => {
  let status = 'running'
  const session = {
    nativeSessionId: 'session-1',
    async startTurn() { return { runId: 'run-1', status: 'accepted' } },
    async getTurn() { return { runId: 'run-1', status } },
  }
  const adapter = createOpenClawAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'terminal', target: target('openclaw') })

  const started = await adapter.startTurn({
    requestId: 'terminal-1',
    bindingKey: 'terminal',
    nativeSessionId: 'session-1',
    target: target('openclaw'),
    message: 'work',
  })
  assert.equal(started.status, 'running')

  const before = await adapter.getTurn({
    requestId: 'terminal-1', bindingKey: 'terminal', nativeSessionId: 'session-1', nativeRunId: 'run-1', target: target('openclaw'),
  })
  assert.equal(before.status, 'running')

  status = 'completed'
  const after = await adapter.getTurn({
    requestId: 'terminal-1', bindingKey: 'terminal', nativeSessionId: 'session-1', nativeRunId: 'run-1', target: target('openclaw'),
  })
  assert.equal(after.status, 'completed')
})

test('OpenClaw cancellation remains stopping until the runtime reports interrupted', async () => {
  let status = 'running'
  const interrupts = []
  const session = {
    nativeSessionId: 'session-1',
    async startTurn() { return { runId: 'run-1', status: 'running' } },
    async interrupt(input) {
      interrupts.push(input)
      return { accepted: true, turn: { sessionId: 'session-1', runId: 'run-1', status: 'stopping' } }
    },
    async getTurn() { return { sessionId: 'session-1', runId: 'run-1', status } },
  }
  const adapter = createOpenClawAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'cancel', target: target('openclaw') })
  await adapter.startTurn({ requestId: 'cancel-1', bindingKey: 'cancel', nativeSessionId: 'session-1', target: target('openclaw'), message: 'work' })

  const requested = await adapter.interruptTurn({
    requestId: 'cancel-1', bindingKey: 'cancel', nativeSessionId: 'session-1', nativeRunId: 'run-1', target: target('openclaw'),
  })
  assert.equal(requested.accepted, true)
  assert.equal(requested.turn.status, 'stopping')
  assert.equal(interrupts[0].nativeSessionId, 'session-1')
  assert.equal(interrupts[0].nativeRunId, 'run-1')

  const stillStopping = await adapter.getTurn({
    requestId: 'cancel-1', bindingKey: 'cancel', nativeSessionId: 'session-1', nativeRunId: 'run-1', target: target('openclaw'),
  })
  assert.equal(stillStopping.status, 'running')

  status = 'interrupted'
  const stopped = await adapter.getTurn({
    requestId: 'cancel-1', bindingKey: 'cancel', nativeSessionId: 'session-1', nativeRunId: 'run-1', target: target('openclaw'),
  })
  assert.equal(stopped.status, 'interrupted')
})

test('OpenClaw turns unknown when queue or Gateway restart makes delivery ambiguous', async () => {
  const session = {
    nativeSessionId: 'session-1',
    async startTurn() {
      const error = new Error('queue restarted')
      error.code = 'QUEUE_RESTART'
      throw error
    },
    async getTurn() { return { runId: 'run-1', status: 'running', gatewayRestarted: true } },
  }
  const adapter = createOpenClawAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'restart', target: target('openclaw') })

  const started = await adapter.startTurn({
    requestId: 'restart-1', bindingKey: 'restart', nativeSessionId: 'session-1', target: target('openclaw'), message: 'side effect',
  })
  assert.equal(started.status, 'unknown')
  assert.equal(started.nativeRunId, null)

  const observed = await adapter.getTurn({
    requestId: 'restart-1', bindingKey: 'restart', nativeSessionId: 'session-1', nativeRunId: 'run-1', target: target('openclaw'),
  })
  assert.equal(observed.status, 'unknown')
})

test('OpenClaw returns unknown for missing runtime state instead of claiming success', async () => {
  const adapter = createOpenClawAdapter({ sessionFor: async () => null })

  const session = await adapter.ensureSession({ bindingKey: 'missing', target: target('openclaw') })
  const turn = await adapter.startTurn({
    requestId: 'missing-1', bindingKey: 'missing', nativeSessionId: null, target: target('openclaw'), message: 'work',
  })

  assert.deepEqual(session, { bindingKey: 'missing', status: 'unknown', nativeSessionId: null })
  assert.deepEqual(turn, { requestId: 'missing-1', nativeSessionId: null, nativeRunId: null, status: 'unknown', lastEventSeq: 0 })
})

test('OpenClaw keeps the legacy bridge session contract intact', async () => {
  const calls = []
  const session = {
    nativeSessionId: 'openclaw:legacy',
    async startTurn(message, input) {
      calls.push({ message, input })
      return { requestId: input.requestId, nativeSessionId: 'openclaw:legacy', nativeRunId: input.requestId, status: 'running', lastEventSeq: 0 }
    },
    async interrupt(input) {
      calls.push({ interrupt: input })
      return { requestId: input.requestId, accepted: true, turn: { requestId: input.requestId, nativeSessionId: input.nativeSessionId, nativeRunId: input.nativeRunId, status: 'stopping', lastEventSeq: 0 } }
    },
    async getTurn(input) {
      return { requestId: input.requestId, nativeSessionId: 'openclaw:legacy', nativeRunId: input.nativeRunId, status: 'completed', lastEventSeq: 1 }
    },
  }
  const adapter = createOpenClawAdapter({ sessionFor: async input => input.recoverOnly ? session : session })
  await adapter.ensureSession({ bindingKey: 'legacy', target: target('openclaw') })

  const turn = await adapter.startTurn({ requestId: 'legacy-1', bindingKey: 'legacy', nativeSessionId: 'openclaw:legacy', target: target('openclaw'), message: 'legacy message', handoff: { version: 1 }, attachments: [] })
  const interrupted = await adapter.interruptTurn({ requestId: 'legacy-1', bindingKey: 'legacy', nativeSessionId: 'openclaw:legacy', nativeRunId: 'legacy-1', target: target('openclaw') })

  assert.equal(turn.nativeRunId, 'legacy-1')
  assert.equal(interrupted.accepted, true)
  assert.equal(calls[0].message, 'legacy message')
  assert.deepEqual(calls[0].input.handoff, { version: 1 })
})

test('OpenClaw filters event records by explicit run identity without confusing event ids for run ids', async () => {
  const session = {
    nativeSessionId: 'session-1',
    async getTurn() { return { nativeSessionId: 'session-1', nativeRunId: 'run-1', status: 'running', lastEventSeq: 2 } },
  }
  const adapter = createOpenClawAdapter({
    sessionFor: async () => session,
    events: async () => ({
      events: [
        { seq: 1, id: 'event-1', type: 'text_delta', payload: { text: 'current' } },
        { seq: 2, id: 'event-2', type: 'text_delta', runId: 'run-old', payload: { text: 'stale' } },
      ],
      turn: { nativeSessionId: 'session-1', nativeRunId: 'run-1', status: 'running', lastEventSeq: 2 },
    }),
  })
  await adapter.ensureSession({ bindingKey: 'events', target: target('openclaw') })

  const page = await adapter.readEvents({
    requestId: 'events-1', bindingKey: 'events', target: target('openclaw'), nativeSessionId: 'session-1', nativeRunId: 'run-1', afterSeq: 0,
  })

  assert.deepEqual(page.events.map(event => event.payload.text), ['current'])
})

test('OpenClaw refuses cancellation when the session reports a different active run', async () => {
  let interruptCalls = 0
  const session = {
    nativeSessionId: 'session-1',
    currentRunId: 'run-current',
    async interrupt() { interruptCalls += 1; return { accepted: true } },
  }
  const adapter = createOpenClawAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'cancel-stale', target: target('openclaw') })

  const result = await adapter.interruptTurn({
    requestId: 'cancel-stale-1', bindingKey: 'cancel-stale', target: target('openclaw'), nativeSessionId: 'session-1', nativeRunId: 'run-requested',
  })

  assert.equal(result.accepted, false)
  assert.equal(result.turn.status, 'unknown')
  assert.equal(interruptCalls, 0)
})

test('OpenClaw does not resolve an unmapped Harness agent through the native runtime', async () => {
  let calls = 0
  const adapter = createOpenClawAdapter({
    agentMap: { 'openclaw.rowlet': { mainAgent: 'rowlet', role: 'worker' } },
    sessionFor: async () => { calls += 1; return { nativeSessionId: 'session-1' } },
  })

  const result = await adapter.ensureSession({ bindingKey: 'unmapped', target: target('openclaw.gengar') })

  assert.deepEqual(result, { bindingKey: 'unmapped', status: 'unknown', nativeSessionId: null })
  assert.equal(calls, 0)
})

test('OpenClaw keeps an explicit restart outcome unknown during cancellation', async () => {
  const session = {
    nativeSessionId: 'session-1',
    async interrupt() {
      return { accepted: true, turn: { nativeSessionId: 'session-1', nativeRunId: 'run-1', status: 'gateway_restarting' } }
    },
  }
  const adapter = createOpenClawAdapter({ sessionFor: async () => session })
  await adapter.ensureSession({ bindingKey: 'cancel-restart', target: target('openclaw') })

  const result = await adapter.interruptTurn({
    requestId: 'cancel-restart-1', bindingKey: 'cancel-restart', target: target('openclaw'), nativeSessionId: 'session-1', nativeRunId: 'run-1',
  })

  assert.equal(result.accepted, true)
  assert.equal(result.turn.status, 'unknown')
})


test('OpenClaw exposes stable DSH ids for the configured native agent list', () => {
  const result = buildOpenClawAgentMap({ dshAgentId: 'openclaw', legacyMainAgent: 'rowlet', role: 'worker', agents: ['rowlet', 'charizard'] })
  assert.deepEqual(result.agentIds, ['openclaw', 'openclaw.rowlet', 'openclaw.charizard'])
  assert.deepEqual(result.agentMap, {
    openclaw: { mainAgent: 'rowlet', role: 'worker' },
    'openclaw.rowlet': { mainAgent: 'rowlet', role: 'worker' },
    'openclaw.charizard': { mainAgent: 'charizard', role: 'worker' },
  })
})
