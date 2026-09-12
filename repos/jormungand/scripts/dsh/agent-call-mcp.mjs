import { createHash, randomUUID } from 'node:crypto'
import { createInterface } from 'node:readline'

const MCP_PROTOCOL_VERSION = '2025-06-18'
const SERVER_NAME = 'dsh-agent-delegation'
const DEFAULT_TIMEOUT_MS = 120_000
const MAX_TIMEOUT_MS = 120_000
const MIN_TIMEOUT_MS = 1_000
const DEFAULT_POLL_INTERVAL_MS = 500
const MAX_MESSAGE_BYTES = 32 * 1024
const MAX_OUTPUT_BYTES = 256 * 1024
const AGENT_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/u

function delegationError(code, message, status) {
  return Object.assign(new Error(message), { code, status })
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number >= 0 ? number : fallback
}

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value.trim() === '') return null
  let parsed
  try { parsed = new URL(value) } catch { return null }
  const loopback = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(parsed.hostname.toLowerCase())
  if ((parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && loopback)) || parsed.username || parsed.password || parsed.search || parsed.hash) return null
  return parsed.origin
}
function normalizeIdentity(value, field) {
  if (typeof value !== 'string' || !AGENT_ID_RE.test(value)) {
    throw delegationError('INVALID_TARGET_CONFIG', `${field} must be a short agent identity`)
  }
  return value
}

function localOrigin(env) {
  return normalizeOrigin(env.DSH_AGENT_DELEGATION_BRIDGE_ORIGIN)
    ?? normalizeOrigin(env.DSH_DELEGATION_BRIDGE_ORIGIN)
    ?? `http://127.0.0.1:${positiveInteger(env.CODEX_BRIDGE_PORT, 4177)}`
}

function defaultTargets(env) {
  const local = localOrigin(env)
  const localToken = env.CODEX_BRIDGE_TOKEN?.trim()
    || env.HARNESS_BRIDGE_TOKEN?.trim()
    || env.DSH_BRIDGE_TOKEN?.trim()
  const piOrigin = normalizeOrigin(env.PI_BRIDGE_URL) ?? local
  const piToken = env.PI_BRIDGE_TOKEN?.trim() || localToken
  const targets = [
    {
      agentId: env.CODEX_AGENT_ID?.trim() || 'codex',
      hostId: env.CODEX_HOST_ID?.trim() || env.DSH_HOST_ID?.trim() || 'B',
      workspaceId: env.CODEX_WORKSPACE_ID?.trim() || env.DSH_CODEX_WORKSPACE_ID?.trim() || 'codex-main',
      origin: local,
      token: localToken,
    },
    {
      agentId: env.PI_AGENT_ID?.trim() || 'pi',
      hostId: env.PI_HOST_ID?.trim() || env.DSH_HOST_ID?.trim() || 'B',
      workspaceId: env.PI_WORKSPACE_ID?.trim() || 'pi-main',
      origin: piOrigin,
      token: piToken,
    },
  ]
  const openClawOrigin = normalizeOrigin(env.OPENCLAW_BRIDGE_URL)
  if (openClawOrigin) {
    targets.push({
      agentId: env.OPENCLAW_AGENT_ID?.trim() || 'openclaw',
      hostId: env.OPENCLAW_HOST_ID?.trim() || 'A',
      workspaceId: env.OPENCLAW_WORKSPACE_ID?.trim() || 'openclaw-main',
      origin: openClawOrigin,
      token: env.OPENCLAW_BRIDGE_TOKEN?.trim(),
    })
  }
  return targets
}

function configuredTargets(env) {
  const raw = env.DSH_AGENT_DELEGATION_TARGETS_JSON?.trim()
  if (!raw) return defaultTargets(env)
  let parsed
  try { parsed = JSON.parse(raw) } catch { throw delegationError('INVALID_TARGET_CONFIG', 'DSH_AGENT_DELEGATION_TARGETS_JSON is invalid') }
  if (!Array.isArray(parsed) || parsed.length === 0) throw delegationError('INVALID_TARGET_CONFIG', 'DSH_AGENT_DELEGATION_TARGETS_JSON must contain targets')
  return parsed.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw delegationError('INVALID_TARGET_CONFIG', 'delegation target must be an object')
    const agentId = normalizeIdentity(value.agentId, 'agentId')
    const hostId = normalizeIdentity(value.hostId, 'hostId')
    const workspaceId = normalizeIdentity(value.workspaceId, 'workspaceId')
    const origin = normalizeOrigin(value.origin)
    if (!origin) throw delegationError('INVALID_TARGET_CONFIG', `invalid origin for ${agentId}`)
    const tokenEnv = typeof value.tokenEnv === 'string' ? value.tokenEnv.trim() : ''
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(tokenEnv)) throw delegationError('INVALID_TARGET_CONFIG', `tokenEnv is required for ${agentId}`)
    const token = env[tokenEnv]?.trim()
    return { agentId, hostId, workspaceId, origin, token }
  })
}

function targetKey(target) {
  return `${target.agentId}:${target.hostId}:${target.workspaceId}`
}

function bindingKey(parentId, target) {
  return `dsh-delegation-${createHash('sha256').update(`${parentId}:${targetKey(target)}`).digest('hex').slice(0, 40)}`
}

function requestId() {
  return `dsh-delegation-${randomUUID()}`
}

function messageSize(message) {
  return Buffer.byteLength(message, 'utf8')
}

function boundedText(value, maxBytes = MAX_OUTPUT_BYTES) {
  const text = typeof value === 'string' ? value : ''
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
  return Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS
  const number = Number(value)
  if (!Number.isInteger(number) || number < MIN_TIMEOUT_MS || number > MAX_TIMEOUT_MS) {
    throw delegationError('INVALID_TIMEOUT', `timeoutMs must be between ${MIN_TIMEOUT_MS} and ${MAX_TIMEOUT_MS}`)
  }
  return number
}

function normalizeTargetInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw delegationError('INVALID_INPUT', 'tool arguments must be an object')
  const agentId = input.agentId
  if (typeof agentId !== 'string' || !agentId.trim()) throw delegationError('INVALID_INPUT', 'agentId is required')
  if (input.hostId !== undefined && (typeof input.hostId !== 'string' || !input.hostId.trim())) throw delegationError('INVALID_INPUT', 'hostId must be a non-empty string')
  if (input.workspaceId !== undefined && (typeof input.workspaceId !== 'string' || !input.workspaceId.trim())) throw delegationError('INVALID_INPUT', 'workspaceId must be a non-empty string')
  const message = input.message
  if (typeof message !== 'string' || message.trim() === '') throw delegationError('INVALID_INPUT', 'message is required')
  if (messageSize(message) > MAX_MESSAGE_BYTES) throw delegationError('INPUT_TOO_LARGE', 'message exceeds the delegation limit')
  return { agentId: agentId.trim(), hostId: input.hostId?.trim(), workspaceId: input.workspaceId?.trim(), message, timeoutMs: normalizeTimeout(input.timeoutMs) }
}

async function readPayload(response) {
  try { return typeof response?.json === 'function' ? await response.json() : null } catch { throw delegationError('INVALID_BRIDGE_RESPONSE', 'bridge returned invalid JSON') }
}

async function requestJson(target, path, { method = 'GET', body, signal, fetchImpl }) {
  let response
  try {
    response = await fetchImpl(`${target.origin}${path}`, {
      method,
      redirect: 'error',
      signal,
      headers: {
        accept: 'application/json',
        ...(target.token ? { authorization: `Bearer ${target.token}` } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch (error) {
    throw delegationError('BRIDGE_UNKNOWN', 'delegation bridge request outcome is unknown', error?.name === 'AbortError' ? 408 : undefined)
  }
  const payload = await readPayload(response)
  if (!response?.ok) {
    const detail = payload?.error ?? {}
    throw delegationError(detail.code ?? `HTTP_${response?.status ?? 0}`, detail.message ?? 'delegation bridge request failed', response?.status)
  }
  return payload
}

function resultError(error) {
  return {
    code: error?.code ?? 'DELEGATION_FAILED',
    message: error?.message ?? 'delegation failed',
    ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
  }
}

function targetDescriptor(target) {
  return { agentId: target.agentId, hostId: target.hostId, workspaceId: target.workspaceId }
}

export function createDelegationService({
  env = process.env,
  fetchImpl = globalThis.fetch,
  sleepImpl = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  parentId = env.DSH_AGENT_DELEGATION_PARENT_ID?.trim() || randomUUID(),
  callerAgentId = env.DSH_AGENT_DELEGATION_CALLER_AGENT?.trim() || 'codex',
  maxDepth = positiveInteger(env.DSH_AGENT_DELEGATION_MAX_DEPTH, 1),
  delegationDepth = nonNegativeInteger(env.DSH_AGENT_DELEGATION_DEPTH, 0),
  pollIntervalMs = positiveInteger(env.DSH_AGENT_DELEGATION_POLL_INTERVAL_MS, DEFAULT_POLL_INTERVAL_MS),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required')
  const targets = configuredTargets(env)
  const targetByAgent = new Map()
  for (const target of targets) {
    if (targetByAgent.has(target.agentId)) throw delegationError('INVALID_TARGET_CONFIG', `duplicate delegation agent: ${target.agentId}`)
    targetByAgent.set(target.agentId, target)
  }

  function resolveTarget(input) {
    const target = targetByAgent.get(input.agentId)
    if (!target) throw delegationError('UNKNOWN_AGENT', `agent is not configured: ${input.agentId}`)
    if (input.hostId && input.hostId !== target.hostId || input.workspaceId && input.workspaceId !== target.workspaceId) {
      throw delegationError('TARGET_IDENTITY_MISMATCH', `target identity does not match configured agent: ${input.agentId}`)
    }
    if (!target.origin || !target.token) throw delegationError('TARGET_UNAVAILABLE', `agent bridge is not configured: ${input.agentId}`)
    return target
  }

  async function listAgents({ signal } = {}) {
    const rows = []
    for (const target of targets) {
      const base = { ...targetDescriptor(target), delegable: target.agentId !== callerAgentId, configured: Boolean(target.origin && target.token) }
      if (!base.configured) { rows.push({ ...base, connection: 'offline' }); continue }
      try {
        const result = await requestJson(target, '/dsh/v1/capabilities', { signal, fetchImpl })
        const agent = result?.agents?.find(value => value?.agentId === target.agentId && (value.hostId === undefined || value.hostId === target.hostId))
        rows.push({ ...base, connection: agent ? 'online' : 'offline', capabilities: agent?.capabilities ?? {} })
      } catch (error) {
        rows.push({ ...base, connection: error?.code === 'BRIDGE_UNKNOWN' ? 'unknown' : 'offline', error: resultError(error) })
      }
    }
    return { callerAgentId, maxDepth, agents: rows }
  }

  async function callAgent(rawInput, { signal } = {}) {
    const input = normalizeTargetInput(rawInput)
    if (callerAgentId === input.agentId) throw delegationError('SELF_DELEGATION_FORBIDDEN', 'a Codex session cannot delegate to itself')
    if (delegationDepth >= maxDepth) throw delegationError('DELEGATION_DEPTH_EXCEEDED', 'delegation depth is exhausted')
    const target = resolveTarget(input)
    const callRequestId = requestId()
    const key = bindingKey(parentId, target)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), input.timeoutMs)
    const onAbort = () => controller.abort()
    signal?.addEventListener('abort', onAbort, { once: true })
    const requestSignal = controller.signal
    let nativeSessionId = null
    let nativeRunId = null
    try {
      const session = await requestJson(target, '/dsh/v1/sessions', {
        method: 'POST',
        signal: requestSignal,
        fetchImpl,
        body: { requestId: callRequestId, bindingKey: key, target: targetDescriptor(target) },
      })
      nativeSessionId = session?.nativeSessionId ?? null
      if (session?.status !== 'ready' || !nativeSessionId) {
        return { requestId: callRequestId, status: 'unknown', target: targetDescriptor(target), nativeSessionId, nativeRunId: null, error: { code: 'SESSION_UNKNOWN', message: 'delegated session was not ready' } }
      }
      const turn = await requestJson(target, '/dsh/v1/turns', {
        method: 'POST',
        signal: requestSignal,
        fetchImpl,
        body: { requestId: callRequestId, bindingKey: key, nativeSessionId, target: targetDescriptor(target), message: input.message, handoff: null, attachments: [] },
      })
      nativeRunId = turn?.nativeRunId ?? null
      if (!nativeRunId || turn?.status === 'unknown') {
        return { requestId: callRequestId, status: 'unknown', target: targetDescriptor(target), nativeSessionId, nativeRunId, error: { code: 'TURN_UNKNOWN', message: 'delegated turn acceptance was not confirmed' } }
      }
      let afterSeq = 0
      let eventText = ''
      while (!requestSignal.aborted) {
        const events = await requestJson(target, `/dsh/v1/turns/${encodeURIComponent(callRequestId)}/events?afterSeq=${afterSeq}`, { signal: requestSignal, fetchImpl })
        for (const event of events?.events ?? []) {
          afterSeq = Math.max(afterSeq, Number(event.seq) || afterSeq)
          if (event.type === 'text_delta' && typeof event.payload?.text === 'string') eventText += event.payload.text
        }
        const receipt = await requestJson(target, `/dsh/v1/turns/by-request/${encodeURIComponent(callRequestId)}`, { signal: requestSignal, fetchImpl })
        const status = receipt?.status
        if (['completed', 'failed', 'interrupted'].includes(status)) {
          const output = boundedText(typeof receipt.output === 'string' && receipt.output ? receipt.output : eventText)
          return {
            requestId: callRequestId, status, target: targetDescriptor(target), nativeSessionId: receipt.nativeSessionId ?? nativeSessionId, nativeRunId: receipt.nativeRunId ?? nativeRunId, output,
            ...(receipt.error ? { error: resultError(receipt.error) } : {}),
          }
        }
        await sleepImpl(pollIntervalMs)
      }
      return { requestId: callRequestId, status: 'unknown', target: targetDescriptor(target), nativeSessionId, nativeRunId, error: { code: 'DELEGATION_TIMEOUT', message: 'delegated turn did not reach a confirmed terminal state before the deadline' } }
    } catch (error) {
      const normalized = resultError(error?.code === 'BRIDGE_UNKNOWN' || requestSignal.aborted ? delegationError('DELEGATION_UNKNOWN', 'delegated turn outcome is unknown') : error)
      return { requestId: callRequestId, status: 'unknown', target: targetDescriptor(target), nativeSessionId, nativeRunId, error: normalized }
    } finally {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
  }

  return {
    targets: () => targets.map(targetDescriptor),
    listAgents,
    callAgent,
    callerAgentId,
    maxDepth,
    delegationDepth,
  }
}

export function buildDelegationTools({ agentIds = [] } = {}) {
  const ids = agentIds.filter(value => typeof value === 'string' && value !== 'codex')
  return [
    {
      name: 'dsh_agents_list',
      description: 'List the configured DSH agents and their live bridge capabilities. Use this before delegating.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'dsh_agent_call',
      description: 'Call one registered DSH agent and wait for its bounded result. Never use this to call yourself; use dsh_agents_list to discover valid targets.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          agentId: { type: 'string', enum: ids },
          hostId: { type: 'string' },
          workspaceId: { type: 'string' },
          message: { type: 'string', minLength: 1, maxLength: MAX_MESSAGE_BYTES },
          timeoutMs: { type: 'integer', minimum: MIN_TIMEOUT_MS, maximum: MAX_TIMEOUT_MS },
        },
        required: ['agentId', 'message'],
      },
    },
  ]
}

function mcpResult(value, isError = false) {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
    isError,
  }
}

export function createMcpHandler({ service } = {}) {
  if (!service || typeof service.callAgent !== 'function' || typeof service.listAgents !== 'function') throw new TypeError('delegation service is required')
  const toolNames = service.targets().filter(target => target.agentId !== service.callerAgentId).map(target => target.agentId)
  const tools = buildDelegationTools({ agentIds: toolNames })
  return async function handle(message) {
    if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') return null
    if (message.method === 'notifications/initialized' || message.method === 'notifications/cancelled') return null
    if (message.method === 'initialize') {
      return { jsonrpc: '2.0', id: message.id, result: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: { tools: { listChanged: false } }, serverInfo: { name: SERVER_NAME, version: '1.0.0' } } }
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id: message.id, result: {} }
    if (message.method === 'tools/list') return { jsonrpc: '2.0', id: message.id, result: { tools } }
    if (message.method === 'tools/call') {
      try {
        const name = message.params?.name
        if (name === 'dsh_agents_list') return { jsonrpc: '2.0', id: message.id, result: mcpResult(await service.listAgents()) }
        if (name === 'dsh_agent_call') {
          const value = await service.callAgent(message.params?.arguments ?? {})
          return { jsonrpc: '2.0', id: message.id, result: mcpResult(value, value.status !== 'completed' || Boolean(value.error)) }
        }
        throw delegationError('UNKNOWN_TOOL', `unknown delegation tool: ${String(name ?? '')}`)
      } catch (error) {
        return { jsonrpc: '2.0', id: message.id, result: mcpResult({ error: resultError(error) }, true) }
      }
    }
    return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `method not found: ${message.method}` } }
  }
}

async function main() {
  const argv = process.argv.slice(2)
  const parentIndex = argv.indexOf('--parent-session-id')
  const parentId = parentIndex >= 0 ? argv[parentIndex + 1] : undefined
  const service = createDelegationService({ parentId })
  const handler = createMcpHandler({ service })
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of input) {
    if (!line.trim()) continue
    let message
    try { message = JSON.parse(line) } catch {
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'invalid JSON' } }) + '\n')
      continue
    }
    try {
      const response = await handler(message)
      if (response) process.stdout.write(JSON.stringify(response) + '\n')
    } catch (error) {
      if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: resultError(error).message } }) + '\n')
    }
  }
}

if (process.argv[1] && process.argv[1].endsWith('agent-call-mcp.mjs')) main().catch(error => {
  process.stderr.write(`dsh delegation MCP failed: ${resultError(error).message}\n`)
  process.exitCode = 1
})
