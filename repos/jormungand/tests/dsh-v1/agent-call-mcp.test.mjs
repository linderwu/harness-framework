import assert from 'node:assert/strict'
import test from 'node:test'

import { buildDelegationTools, createDelegationService, createMcpHandler } from '../../scripts/dsh/agent-call-mcp.mjs'

function response(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body }
}

test('delegation MCP exposes discovery and call tools', async () => {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url: String(url), init })
    if (String(url).endsWith('/dsh/v1/sessions')) return response({ status: 'ready', nativeSessionId: 'pi:delegated' }, 201)
    if (String(url).endsWith('/dsh/v1/turns')) return response({ status: 'running', nativeSessionId: 'pi:delegated', nativeRunId: 'run-1' }, 202)
    if (String(url).includes('/dsh/v1/turns/by-request/')) return response({ status: 'completed', nativeSessionId: 'pi:delegated', nativeRunId: 'run-1', output: 'PI_OK' })
    if (String(url).includes('/dsh/v1/turns/') && String(url).endsWith('/events?afterSeq=0')) return response({ events: [], nextSeq: 0 })
    throw new Error(`unexpected URL: ${url}`)
  }
  const service = createDelegationService({
    env: {
      DSH_AGENT_DELEGATION_TARGETS_JSON: JSON.stringify([{ agentId: 'pi', hostId: 'B', workspaceId: 'pi-main', origin: 'http://127.0.0.1:4177', tokenEnv: 'TEST_BRIDGE_TOKEN' }]),
      TEST_BRIDGE_TOKEN: 'bridge-secret',
    },
    fetchImpl,
    sleepImpl: async () => undefined,
  })
  const handler = createMcpHandler({ service, callerAgentId: 'codex' })

  const initialized = await handler({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  assert.equal(initialized.result.serverInfo.name, 'dsh-agent-delegation')

  const listed = await handler({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['dsh_agents_list', 'dsh_agent_call'])
  assert.deepEqual(buildDelegationTools({ agentIds: ['pi'] }).map(tool => tool.name), ['dsh_agents_list', 'dsh_agent_call'])

  const called = await handler({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'dsh_agent_call', arguments: { agentId: 'pi', message: 'return PI_OK' } },
  })
  assert.equal(called.result.isError, false)
  assert.equal(JSON.parse(called.result.content[0].text).output, 'PI_OK')
  assert.equal(calls.length, 4)
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer bridge-secret')
})

test('delegation MCP rejects self calls before network I/O', async () => {
  let fetches = 0
  const service = createDelegationService({
    env: { CODEX_BRIDGE_TOKEN: 'secret' },
    fetchImpl: async () => { fetches += 1; return response({}) },
  })
  const handler = createMcpHandler({ service, callerAgentId: 'codex' })
  const result = await handler({
    jsonrpc: '2.0',
    id: 4,
    method: 'tools/call',
    params: { name: 'dsh_agent_call', arguments: { agentId: 'codex', message: 'loop' } },
  })
  assert.equal(result.result.isError, true)
  assert.match(result.result.content[0].text, /SELF_DELEGATION_FORBIDDEN/)
  assert.equal(fetches, 0)
})


test('delegation MCP rejects mismatched identities and exhausted depth', async () => {
  let fetches = 0
  const baseEnv = {
    DSH_AGENT_DELEGATION_TARGETS_JSON: JSON.stringify([{ agentId: 'pi', hostId: 'B', workspaceId: 'pi-main', origin: 'http://127.0.0.1:4177', tokenEnv: 'TEST_BRIDGE_TOKEN' }]),
    TEST_BRIDGE_TOKEN: 'bridge-secret',
  }
  const service = createDelegationService({ env: baseEnv, fetchImpl: async () => { fetches += 1; return response({}) } })
  const handler = createMcpHandler({ service, callerAgentId: 'codex' })

  const mismatch = await handler({
    jsonrpc: '2.0',
    id: 5,
    method: 'tools/call',
    params: { name: 'dsh_agent_call', arguments: { agentId: 'pi', hostId: 'A', message: 'nope' } },
  })
  assert.equal(mismatch.result.isError, true)
  assert.match(mismatch.result.content[0].text, /TARGET_IDENTITY_MISMATCH/)

  const depthService = createDelegationService({
    env: { ...baseEnv, DSH_AGENT_DELEGATION_DEPTH: '1', DSH_AGENT_DELEGATION_MAX_DEPTH: '1' },
    fetchImpl: async () => { fetches += 1; return response({}) },
  })
  const depth = await createMcpHandler({ service: depthService, callerAgentId: 'codex' })({
    jsonrpc: '2.0',
    id: 6,
    method: 'tools/call',
    params: { name: 'dsh_agent_call', arguments: { agentId: 'pi', message: 'nope' } },
  })
  assert.equal(depth.result.isError, true)
  assert.match(depth.result.content[0].text, /DELEGATION_DEPTH_EXCEEDED/)
  assert.equal(fetches, 0)
})

test('delegation MCP returns unknown when a target never settles', async () => {
  const service = createDelegationService({
    env: {
      DSH_AGENT_DELEGATION_TARGETS_JSON: JSON.stringify([{ agentId: 'pi', hostId: 'B', workspaceId: 'pi-main', origin: 'http://127.0.0.1:4177', tokenEnv: 'TEST_BRIDGE_TOKEN' }]),
      TEST_BRIDGE_TOKEN: 'bridge-secret',
    },
    fetchImpl: async (url) => {
      if (String(url).endsWith('/sessions')) return response({ status: 'ready', nativeSessionId: 'pi:delegated' }, 201)
      if (String(url).endsWith('/turns')) return response({ status: 'running', nativeSessionId: 'pi:delegated', nativeRunId: 'run-1' }, 202)
      if (String(url).includes('/events?afterSeq=0')) return response({ events: [] })
      return response({ status: 'running', nativeSessionId: 'pi:delegated', nativeRunId: 'run-1' })
    },
    sleepImpl: async (ms) => new Promise(resolve => setTimeout(resolve, Math.min(ms, 10))),
  })
  const handler = createMcpHandler({ service })
  const result = await handler({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name: 'dsh_agent_call', arguments: { agentId: 'pi', message: 'wait', timeoutMs: 1000 } },
  })
  assert.equal(result.result.isError, true)
  assert.match(result.result.content[0].text, /DELEGATION_UNKNOWN|DELEGATION_TIMEOUT/)
})

test('delegation rejects non-loopback HTTP target origins', () => {
  assert.throws(
    () => createDelegationService({
      env: {
        DSH_AGENT_DELEGATION_TARGETS_JSON: JSON.stringify([{ agentId: 'pi', hostId: 'B', workspaceId: 'pi-main', origin: 'http://192.168.50.1:4177', tokenEnv: 'TEST_BRIDGE_TOKEN' }]),
        TEST_BRIDGE_TOKEN: 'bridge-secret',
      },
      fetchImpl: async () => response({}),
    }),
    { code: 'INVALID_TARGET_CONFIG' },
  )
})
