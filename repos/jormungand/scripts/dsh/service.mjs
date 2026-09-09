import { validateHandoff, validateTarget } from './input.mjs'

function serviceError(code, message, httpStatus = 400, retryable = false) {
  const error = new Error(message)
  error.code = code
  error.httpStatus = httpStatus
  error.retryable = retryable
  return error
}

function selectAdapter(registry, target) {
  const entry = registry.find(item => item.agentId === target.agentId && item.hostId === target.hostId)
  if (!entry) throw serviceError('UNKNOWN_TARGET', 'target is not registered', 422)
  return entry.adapter
}

function bindingKey(target) {
  return `${target.agentId}-${target.hostId}-${target.workspaceId}`.replace(/[^a-zA-Z0-9_-]/gu, '_').slice(0, 180)
}

export function createDshService({ registry = [], store, readQuotaSource = async () => null }) {
  if (!store) throw new Error('store is required')
  const findAdapter = target => selectAdapter(registry, validateTarget(target))

  async function getCapabilities() {
    return {
      schemaVersion: 'dsh-agent-bridge/v1',
      hostId: registry[0]?.hostId ?? null,
      agents: registry.map(item => ({ agentId: item.agentId, capabilities: item.capabilities ?? {} })),
      limits: { maxRequestBytes: 1024 * 1024, maxEventPageBytes: 256 * 1024, maxEventPageItems: 200 },
      observedAt: new Date().toISOString(),
    }
  }

  async function listModels({ agentId, hostId }) {
    const entry = registry.find(item => item.agentId === agentId && (!hostId || item.hostId === hostId))
    if (!entry) throw serviceError('UNKNOWN_TARGET', 'agent is not registered', 422)
    if (typeof entry.adapter?.listModels !== 'function') throw serviceError('CAPABILITY_UNAVAILABLE', 'model listing is unavailable', 501)
    return entry.adapter.listModels({ agentId })
  }

  async function getQuota({ agentId, hostId }) {
    const entry = registry.find(item => item.agentId === agentId && (!hostId || item.hostId === hostId))
    if (!entry) throw serviceError('UNKNOWN_TARGET', 'agent is not registered', 422)
    if (entry.quotaSourceId) return readQuotaSource({ quotaSourceId: entry.quotaSourceId })
    if (typeof entry.adapter?.getQuota !== 'function') return null
    return entry.adapter.getQuota({ agentId })
  }

  async function getInputBudget({ bindingKey: key, target }) {
    const normalized = validateTarget(target)
    const adapter = findAdapter(normalized)
    if (typeof adapter.getInputBudget !== 'function') return { nativeAvailableInputTokens: null, reservedOutputTokens: null, nativeCompactionSupported: false, admission: 'unverified', observedAt: new Date().toISOString() }
    return adapter.getInputBudget({ bindingKey: key, target: normalized })
  }

  async function ensureSession({ bindingKey: key, requestId, target, recoverOnly = false }) {
    const normalized = validateTarget(target)
    const adapter = findAdapter(normalized)
    if (typeof adapter.ensureSession !== 'function') throw serviceError('CAPABILITY_UNAVAILABLE', 'session support is unavailable', 501)
    if (recoverOnly) {
      return adapter.ensureSession({ bindingKey: key, requestId, target: normalized, recoverOnly: true })
    }
    const reserved = await store.transact(() => store.reserve('session', requestId, { bindingKey: key, target: normalized, status: 'prepared', payloadHash: `${key}:${JSON.stringify(normalized)}` }))
    if (!reserved.created && reserved.record.nativeSessionId) return reserved.record
    if (!reserved.created && ['unknown', 'submitted'].includes(reserved.record.status)) return { bindingKey: key, status: reserved.record.status, nativeSessionId: reserved.record.nativeSessionId ?? null }
    let result
    try {
      result = await adapter.ensureSession({ bindingKey: key, requestId, target: normalized, recoverOnly: false })
    } catch (error) {
      await store.patch('session', requestId, { status: 'unknown', error: error.code ?? 'SESSION_UNKNOWN' })
      throw error
    }
    await store.patch('session', requestId, { ...result, status: result?.status ?? 'unknown' })
    await store.putBinding(key, {
      bindingKey: key,
      target: normalized,
      nativeSessionId: result?.nativeSessionId ?? null,
      status: result?.status ?? 'unknown',
      updatedAt: new Date().toISOString(),
    })
    return result
  }

  async function recoverSession({ bindingKey: key }) {
    const record = await store.read('bindings', key)
    if (!record?.target) throw serviceError('RECEIPT_NOT_FOUND', 'session binding not found', 404)
    return ensureSession({
      bindingKey: key,
      requestId: `recover-${key}`,
      target: record.target,
      recoverOnly: true,
    })
  }

  async function startTurn({ requestId, bindingKey: key, nativeSessionId, target, message, handoff, attachments = [] }) {
    const normalized = validateTarget(target)
    validateHandoff(handoff)
    if (typeof message !== 'string' || message.length === 0) throw serviceError('INVALID_TURN', 'message is required')
    const adapter = findAdapter(normalized)
    if (typeof adapter.startTurn !== 'function') throw serviceError('CAPABILITY_UNAVAILABLE', 'turn support is unavailable', 501)
    const payloadHash = JSON.stringify({ key, nativeSessionId, target: normalized, message, handoff, attachments })
    const reserved = await store.transact(() => store.reserve('turn', requestId, { bindingKey: key, nativeSessionId, target: normalized, status: 'prepared', payloadHash }))
    if (!reserved.created) return reserved.record
    await store.patch('turn', requestId, { status: 'submitted', submissionAttempted: true })
    let result
    try {
      result = await adapter.startTurn({ requestId, bindingKey: key, nativeSessionId, target: normalized, message, handoff, attachments })
    } catch (error) {
      await store.patch('turn', requestId, { status: 'unknown', error: error.code ?? 'TURN_UNKNOWN' })
      return { requestId, nativeSessionId: nativeSessionId ?? null, nativeRunId: null, status: 'unknown', lastEventSeq: 0 }
    }
    return store.patch('turn', requestId, { ...result, status: result?.status ?? 'running' })
  }

  async function getTurn({ requestId }) {
    const record = await store.read('operations/turn', requestId)
    if (!record) throw serviceError('RECEIPT_NOT_FOUND', 'turn receipt not found', 404)
    const adapter = record.target ? findAdapter(record.target) : null
    if (typeof adapter?.getTurn !== 'function') return record
    const fresh = await adapter.getTurn({ requestId, ...record })
    if (!fresh || !fresh.status || fresh.status === record.status) return record
    if (['completed', 'interrupted', 'failed'].includes(record.status) && !['completed', 'interrupted', 'failed'].includes(fresh.status)) return record
    return store.patch('turn', requestId, fresh)
  }

  async function readEvents({ requestId, afterSeq = 0 }) {
    const record = await store.read('operations/turn', requestId)
    if (!record) throw serviceError('RECEIPT_NOT_FOUND', 'turn receipt not found', 404)
    const adapter = record.target ? findAdapter(record.target) : null
    if (typeof adapter?.readEvents === 'function') {
      const native = await adapter.readEvents({ requestId, ...record, afterSeq })
      for (const event of native?.events ?? []) await store.append(requestId, event)
      if (native?.turn) await store.patch('turn', requestId, native.turn)
    }
    return store.readEvents(requestId, afterSeq)
  }

  async function interruptTurn({ requestId, nativeSessionId, nativeRunId }) {
    const record = await getTurn({ requestId })
    if (record.nativeSessionId !== nativeSessionId || record.nativeRunId !== nativeRunId) throw serviceError('NATIVE_ID_MISMATCH', 'native turn identity does not match receipt', 409)
    const adapter = findAdapter(record.target)
    if (typeof adapter.interruptTurn !== 'function') throw serviceError('CAPABILITY_UNAVAILABLE', 'interrupt is unavailable', 501)
    const result = await adapter.interruptTurn({
      requestId,
      bindingKey: record.bindingKey,
      target: record.target,
      nativeSessionId,
      nativeRunId,
    })
    await store.patch('turn', requestId, { status: result?.turn?.status ?? 'stopping' })
    return { requestId, accepted: result?.accepted === true, turn: result?.turn ?? { ...record, status: 'stopping' } }
  }

  return { getCapabilities, listModels, getQuota, getInputBudget, ensureSession, recoverSession, startTurn, getTurn, readEvents, interruptTurn, bindingKey }
}

export { selectAdapter }
