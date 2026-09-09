import assert from 'node:assert/strict'
import test from 'node:test'
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
