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

test('Pi adapter uses JSONL prompt and abort controls while retaining event cursor', async () => {
  const child = fakeChild()
  const adapter = createPiAdapter({ spawnImpl: () => child, cwdFor: () => process.cwd() })
  const target = { agentId: 'pi', hostId: 'B', workspaceId: 'repo' }
  const session = await adapter.ensureSession({ bindingKey: 'b', target })
  const turn = await adapter.startTurn({ requestId: 'r', bindingKey: 'b', target, message: 'inspect files' })
  assert.equal(turn.status, 'running')
  assert.deepEqual(JSON.parse(child.stdin.writes.at(-1)), { type: 'prompt', message: 'inspect files' })
  child.stdout.emit('data', `${JSON.stringify({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'ok' } })}\n`)
  const page = await adapter.readEvents({ requestId: 'r', bindingKey: 'b', target, afterSeq: 0 })
  assert.equal(page.events.some((event) => event.type === 'text_delta'), true)
  const interrupted = await adapter.interruptTurn({ requestId: 'r', bindingKey: 'b', target, nativeSessionId: session.nativeSessionId, nativeRunId: 'r' })
  assert.equal(interrupted.accepted, true)
  assert.deepEqual(JSON.parse(child.stdin.writes.at(-1)), { type: 'abort' })
})

