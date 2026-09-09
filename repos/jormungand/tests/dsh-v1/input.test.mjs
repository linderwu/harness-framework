import assert from 'node:assert/strict'
import test from 'node:test'
import { encodeInput, validateHandoff, validateTarget } from '../../scripts/dsh/input.mjs'

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
