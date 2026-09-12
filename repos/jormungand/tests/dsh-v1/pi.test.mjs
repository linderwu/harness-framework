import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import { createPiAdapter } from '../../scripts/dsh/pi.mjs'

function fakeChild() {
  const child = new EventEmitter()
  child.stdin = { destroyed: false, writes: [], write(value) { this.writes.push(value) } }
  child.stdout = new EventEmitter()
  child.stderr = new EventEmitter()
  return child
}

function emitJson(child, value) {
  child.stdout.emit('data', `${JSON.stringify(value)}\n`)
}

function emitResponse(child, command, { id, success = true, data, error } = {}) {
  emitJson(child, {
    type: 'response',
    id,
    command,
    success,
    ...(data === undefined ? {} : { data }),
    ...(error === undefined ? {} : { error }),
  })
}

async function waitForWrites(child, count) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (child.stdin.writes.length >= count) return
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.fail(`expected ${count} writes, got ${child.stdin.writes.length}`)
}

function writtenCommands(child) {
  return child.stdin.writes.map((value) => JSON.parse(value))
}

test('Pi adapter resolves Windows npm command shims for the default executable', async () => {
  const calls = []
  const adapter = createPiAdapter({
    spawnImpl: (...args) => { calls.push(args); return fakeChild() },
    command: 'pi',
    cwdFor: () => process.cwd(),
  })
  await adapter.ensureSession({ bindingKey: 'platform-command', target: { workspaceId: 'repo' } })
  if (process.platform === 'win32') {
    assert.equal(calls[0][0], process.env.ComSpec ?? 'cmd.exe')
    assert.deepEqual(calls[0][1].slice(0, 3), ['/d', '/s', '/c'])
    assert.equal('shell' in calls[0][2], false)
  } else {
    assert.equal(calls[0][0], 'pi')
    assert.equal('shell' in calls[0][2], false)
  }
})

test('Pi adapter correlates model and prompt responses before accepting a turn', async () => {
  const child = fakeChild()
  const adapter = createPiAdapter({ spawnImpl: () => child, cwdFor: () => process.cwd() })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'repo', modelId: 'anthropic:fixture-model' }
  const ensured = await adapter.ensureSession({ bindingKey: 'correlation', target })

  const turnPromise = adapter.startTurn({ requestId: 'turn-1', bindingKey: 'correlation', nativeSessionId: ensured.nativeSessionId, target, message: 'inspect files' })
  await waitForWrites(child, 1)
  const [setModel] = writtenCommands(child)
  assert.equal(setModel.type, 'set_model')
  assert.equal(setModel.id, 'turn-1:set_model')
  assert.deepEqual({ provider: setModel.provider, modelId: setModel.modelId }, { provider: 'anthropic', modelId: 'fixture-model' })

  emitResponse(child, 'prompt', { id: 'unrelated', success: true })
  emitResponse(child, 'set_model', { id: setModel.id, success: true, data: { id: 'fixture-model' } })
  await waitForWrites(child, 2)
  const [, prompt] = writtenCommands(child)
  assert.equal(prompt.type, 'prompt')
  assert.equal(prompt.id, 'turn-1')

  emitResponse(child, 'prompt', { id: prompt.id, success: true })
  const turn = await turnPromise
  assert.deepEqual(turn, {
    requestId: 'turn-1',
    nativeSessionId: 'pi:correlation',
    nativeRunId: 'turn-1',
    status: 'running',
    lastEventSeq: 0,
  })
})

test('Pi adapter preserves UTF-8 JSONL framing, LF-only records, and CRLF compatibility', async () => {
  const child = fakeChild()
  const adapter = createPiAdapter({ spawnImpl: () => child, cwdFor: () => process.cwd() })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'repo' }
  const ensured = await adapter.ensureSession({ bindingKey: 'utf8', target })
  const turnPromise = adapter.startTurn({ requestId: 'utf8-run', bindingKey: 'utf8', nativeSessionId: ensured.nativeSessionId, target, message: 'prompt' })
  await waitForWrites(child, 1)
  emitResponse(child, 'prompt', { id: 'utf8-run', success: true })
  await turnPromise

  const line = `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '中文\u2028分隔' } })}\r\n`
  const bytes = Buffer.from(line)
  const split = bytes.indexOf(0xe4)
  child.stdout.emit('data', bytes.subarray(0, split + 1))
  child.stdout.emit('data', bytes.subarray(split + 1))
  const page = await adapter.readEvents({ requestId: 'utf8-run', bindingKey: 'utf8', target, nativeSessionId: ensured.nativeSessionId, nativeRunId: 'utf8-run', afterSeq: 0 })
  assert.equal(page.events.some((event) => event.payload?.text === '中文\u2028分隔'), true)
})

test('Pi adapter surfaces set_model errors and does not send a prompt', async () => {
  const child = fakeChild()
  const adapter = createPiAdapter({ spawnImpl: () => child, cwdFor: () => process.cwd() })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'repo', modelId: 'bad:model' }
  const ensured = await adapter.ensureSession({ bindingKey: 'model-error', target })
  const turnPromise = adapter.startTurn({ requestId: 'bad-turn', bindingKey: 'model-error', nativeSessionId: ensured.nativeSessionId, target, message: 'work' })
  await waitForWrites(child, 1)
  emitResponse(child, 'set_model', { id: 'bad-turn:set_model', success: false, error: 'Model not found' })
  await assert.rejects(turnPromise, { code: 'INVALID_MODEL', message: 'Model not found' })
  assert.equal(child.stdin.writes.length, 1)
})

test('Pi session remains persistent for a binding but recovery never claims unsupported resume', async () => {
  const children = []
  const adapter = createPiAdapter({ spawnImpl: () => { const child = fakeChild(); children.push(child); return child }, cwdFor: () => 'C:/fixture/workspace' })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'repo' }
  const first = await adapter.ensureSession({ bindingKey: 'persist', target })
  const second = await adapter.ensureSession({ bindingKey: 'persist', target })
  assert.equal(children.length, 1)
  assert.deepEqual(second, first)
  assert.equal(adapter.capabilities.sessionResume, false)

  children[0].emit('close', 0)
  assert.deepEqual(await adapter.ensureSession({ bindingKey: 'persist', target, recoverOnly: true }), {
    bindingKey: 'persist',
    status: 'unknown',
    nativeSessionId: null,
  })
  assert.equal(children.length, 1)
})

test('Pi adapter retains complete final output through settlement and reconnect polling', async () => {
  const child = fakeChild()
  const adapter = createPiAdapter({ spawnImpl: () => child, cwdFor: () => process.cwd() })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'repo' }
  const ensured = await adapter.ensureSession({ bindingKey: 'output', target })
  const turnPromise = adapter.startTurn({ requestId: 'output-run', bindingKey: 'output', nativeSessionId: ensured.nativeSessionId, target, message: 'answer' })
  await waitForWrites(child, 1)
  emitResponse(child, 'prompt', { id: 'output-run', success: true })
  await turnPromise

  emitJson(child, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '完整' } })
  emitJson(child, { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '答案' } })
  emitJson(child, {
    type: 'agent_end',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'answer' }] },
      { role: 'assistant', content: [{ type: 'text', text: '完整答案' }] },
    ],
  })
  const beforeSettled = await adapter.getTurn({ requestId: 'output-run', bindingKey: 'output', nativeSessionId: ensured.nativeSessionId, nativeRunId: 'output-run' })
  assert.equal(beforeSettled.status, 'running')
  assert.equal(beforeSettled.output, '完整答案')

  emitJson(child, { type: 'agent_settled' })
  child.emit('close', 0)
  const afterReconnect = await adapter.getTurn({ requestId: 'output-run', bindingKey: 'output', nativeSessionId: ensured.nativeSessionId, nativeRunId: 'output-run' })
  assert.equal(afterReconnect.status, 'completed')
  assert.equal(afterReconnect.output, '完整答案')
})

test('Pi adapter keeps queued work running until agent_settled and rejects overlapping turns', async () => {
  const child = fakeChild()
  const adapter = createPiAdapter({ spawnImpl: () => child, cwdFor: () => process.cwd() })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'repo' }
  const ensured = await adapter.ensureSession({ bindingKey: 'queue', target })
  const turnPromise = adapter.startTurn({ requestId: 'queue-run', bindingKey: 'queue', nativeSessionId: ensured.nativeSessionId, target, message: 'work' })
  await waitForWrites(child, 1)
  emitResponse(child, 'prompt', { id: 'queue-run', success: true, data: { queued: true } })
  await turnPromise

  emitJson(child, { type: 'queue_update', steering: ['focus'], followUp: ['summarize'] })
  emitJson(child, { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'first' }] }] })
  const queuedEvents = await adapter.readEvents({ requestId: 'queue-run', bindingKey: 'queue', nativeSessionId: ensured.nativeSessionId, nativeRunId: 'queue-run', afterSeq: 0 })
  assert.equal(queuedEvents.events.some((event) => event.payload?.queueDepth === 2), true)
  assert.equal((await adapter.getTurn({ requestId: 'queue-run', bindingKey: 'queue', nativeSessionId: ensured.nativeSessionId, nativeRunId: 'queue-run' })).status, 'running')
  await assert.rejects(
    adapter.startTurn({ requestId: 'overlap', bindingKey: 'queue', nativeSessionId: ensured.nativeSessionId, target, message: 'second' }),
    { code: 'PI_BUSY' },
  )

  emitJson(child, { type: 'agent_settled' })
  assert.equal((await adapter.getTurn({ requestId: 'queue-run', bindingKey: 'queue', nativeSessionId: ensured.nativeSessionId, nativeRunId: 'queue-run' })).status, 'completed')
})

test('Pi interrupt is accepted first and becomes interrupted only after settlement', async () => {
  const child = fakeChild()
  const adapter = createPiAdapter({ spawnImpl: () => child, cwdFor: () => process.cwd() })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'repo' }
  const session = await adapter.ensureSession({ bindingKey: 'abort', target })
  const turnPromise = adapter.startTurn({ requestId: 'abort-run', bindingKey: 'abort', nativeSessionId: session.nativeSessionId, target, message: 'stop me' })
  await waitForWrites(child, 1)
  emitResponse(child, 'prompt', { id: 'abort-run', success: true })
  await turnPromise

  const interruptPromise = adapter.interruptTurn({ requestId: 'abort-request', bindingKey: 'abort', nativeSessionId: session.nativeSessionId, nativeRunId: 'abort-run' })
  await waitForWrites(child, 2)
  const abort = writtenCommands(child).at(-1)
  assert.equal(abort.type, 'abort')
  assert.equal(abort.id, 'abort-request:abort')
  emitResponse(child, 'abort', { id: abort.id, success: true })
  const accepted = await interruptPromise
  assert.equal(accepted.accepted, true)
  assert.equal(accepted.turn.status, 'stopping')

  emitJson(child, { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'stopped' }] }] })
  assert.equal((await adapter.getTurn({ requestId: 'abort-run', bindingKey: 'abort', nativeSessionId: session.nativeSessionId, nativeRunId: 'abort-run' })).status, 'stopping')
  emitJson(child, { type: 'agent_settled' })
  assert.equal((await adapter.getTurn({ requestId: 'abort-run', bindingKey: 'abort', nativeSessionId: session.nativeSessionId, nativeRunId: 'abort-run' })).status, 'interrupted')
})

test('Pi clean process exit before agent_settled remains unknown', async () => {
  const child = fakeChild()
  const adapter = createPiAdapter({ spawnImpl: () => child, cwdFor: () => process.cwd() })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'exit-before-settle' }
  const ensured = await adapter.ensureSession({ bindingKey: 'exit-before-settle', target })
  const turnPromise = adapter.startTurn({ requestId: 'exit-run', bindingKey: 'exit-before-settle', nativeSessionId: ensured.nativeSessionId, target, message: 'work' })
  await waitForWrites(child, 1)
  emitResponse(child, 'prompt', { id: 'exit-run', success: true })
  await turnPromise
  child.emit('close', 0)
  const turn = await adapter.getTurn({ requestId: 'exit-run', bindingKey: 'exit-before-settle', nativeSessionId: ensured.nativeSessionId, nativeRunId: 'exit-run' })
  assert.equal(turn.status, 'unknown')
})

test('Pi adapter selects the workspace cwd for each native process', async () => {
  const calls = []
  const adapter = createPiAdapter({
    spawnImpl: (...args) => { calls.push(args); return fakeChild() },
    cwdFor: (target) => `C:/workspaces/${target.workspaceId}`,
  })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'project-42' }
  await adapter.ensureSession({ bindingKey: 'cwd', target })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][2].cwd, 'C:/workspaces/project-42')
  if (process.platform === 'win32') {
    assert.deepEqual(calls[0][1].slice(0, 3), ['/d', '/s', '/c'])
    assert.match(calls[0][1][3], /--mode rpc/)
  } else {
    assert.deepEqual(calls[0][1], ['--mode', 'rpc'])
  }
})

test('Pi adapter rejects unsupported attachments and reasoning instead of silently claiming support', async () => {
  const child = fakeChild()
  const adapter = createPiAdapter({ spawnImpl: () => child, cwdFor: () => process.cwd() })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'unsupported' }
  const ensured = await adapter.ensureSession({ bindingKey: 'unsupported', target })
  await assert.rejects(
    adapter.startTurn({ requestId: 'attachments', bindingKey: 'unsupported', nativeSessionId: ensured.nativeSessionId, target, message: 'work', attachments: [{ reference: 'a' }] }),
    { code: 'CAPABILITY_UNAVAILABLE' },
  )
  await assert.rejects(
    adapter.startTurn({ requestId: 'reasoning', bindingKey: 'unsupported', nativeSessionId: ensured.nativeSessionId, target: { ...target, reasoningEffort: 'high' }, message: 'work' }),
    { code: 'CAPABILITY_UNAVAILABLE' },
  )
  assert.equal(child.stdin.writes.length, 0)
})
