import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeInput, formatHandoffPrompt, validateHandoff, validateTarget } from '../../scripts/dsh/input.mjs'

test('input keeps unicode and rejects over-byte JSON', () => {
  const value = { message: '保留換行\n' }
  assert.deepEqual(JSON.parse(encodeInput(value)), value)
  assert.throws(() => encodeInput({ message: 'x'.repeat(1024 * 1024) }), { code: 'INPUT_TOO_LARGE' })
})

test('target and handoff schemas are explicit', () => {
  assert.deepEqual(validateTarget({ agentId: 'codex', hostId: 'B', workspaceId: 'ws' }), { agentId: 'codex', hostId: 'B', workspaceId: 'ws' })
  assert.throws(() => validateTarget({ agentId: 'codex' }), { code: 'INVALID_TARGET' })
  assert.throws(() => validateHandoff({ version: 0 }), { code: 'INVALID_HANDOFF' })
  assert.equal(validateHandoff(null), null)
})

test('handoff formatting keeps source IDs and sends the current request once', () => {
  const text = formatHandoffPrompt('現在問題', {
    version: 1,
    messages: [{ id: 'u1', role: 'user', text: '之前', source: { kind: 'dsh' } }],
    summaries: [],
  })
  assert.match(text, /u1/)
  assert.equal(text.match(/現在問題/g).length, 1)
})
