const RUNNING_STATUSES = new Set([
  'accepted',
  'active',
  'in_progress',
  'inprogress',
  'pending',
  'queued',
  'running',
  'started',
  'submitted',
])
const STOPPING_STATUSES = new Set(['cancel_requested', 'cancelling', 'stopping'])
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'interrupted'])
const UNKNOWN_STATUSES = new Set([
  'disconnected',
  'gateway_restart',
  'gateway_restarting',
  'lost',
  'reconnecting',
  'restarting',
  'timeout',
  'unknown',
])
const AMBIGUOUS_ERROR_CODES = new Set([
  'ABORT_ERR',
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'GATEWAY_RESTART',
  'GATEWAY_RESTARTED',
  'GATEWAY_RESTARTING',
  'QUEUE_RESTART',
  'QUEUE_RESTARTED',
  'QUEUE_RESTARTING',
  'TRANSPORT_DISCONNECTED',
  'TRANSPORT_UNKNOWN',
])

/**
 * Resolve the DSH agent identity to the native OpenClaw agent and role.
 * `agentMap` is intentionally optional so the legacy bridge can continue to
 * pass its existing `agentId` through unchanged.
 */
export function resolveOpenClawTarget(target = {}, { agentMap, roleMap, roles } = {}) {
  const dshAgentId = typeof target.agentId === 'string' ? target.agentId : ''
  if (!dshAgentId) return null

  const configuredMapping = lookupMapping(agentMap, dshAgentId, target)
  if (agentMap !== undefined && agentMap !== null && configuredMapping === undefined) {
    return null
  }

  const mapping = normalizeMapping(configuredMapping)
  const mainAgent = mapping?.mainAgent ?? legacyMainAgent(dshAgentId)
  if (!mainAgent) return null

  const configuredRole = lookupMapping(roleMap ?? roles, dshAgentId, target)
  const role = mapping?.role ?? normalizeRole(configuredRole) ?? normalizeRole(target.role) ?? 'openclaw'
  const runtimeTarget = {
    ...target,
    agentId: mainAgent,
    dshAgentId,
    mainAgent,
    role,
  }

  return { dshAgentId, mainAgent, role, target: runtimeTarget }
}

/** Normalize native/provider status into the DSH v1 status vocabulary. */
export function normalizeOpenClawStatus(value) {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replaceAll('-', '_')
    .replaceAll(' ', '_')

  if (RUNNING_STATUSES.has(normalized)) return 'running'
  if (STOPPING_STATUSES.has(normalized)) return 'stopping'
  if (TERMINAL_STATUSES.has(normalized)) return normalized
  if (normalized === 'cancelled' || normalized === 'canceled' || normalized === 'stopped') return 'interrupted'
  if (normalized === 'complete' || normalized === 'done' || normalized === 'success' || normalized === 'succeeded') return 'completed'
  if (normalized === 'error' || normalized === 'failure') return 'failed'
  if (UNKNOWN_STATUSES.has(normalized) || normalized.includes('restart')) return 'unknown'
  return 'unknown'
}

/** Whether a native failure leaves delivery ambiguous and requires recovery. */
export function isOpenClawUnknownError(error) {
  if (!error) return false
  if (error.deliveryState === 'unknown' || error.unknown === true || error.retryable === true) return true
  if (error.name === 'AbortError') return true
  const code = String(error.code ?? '').toUpperCase()
  if (AMBIGUOUS_ERROR_CODES.has(code)) return true
  const message = String(error.message ?? error).toLowerCase()
  return /gateway|queue|restart|timeout|timed out|disconnect|connection reset|broken pipe/.test(message)
}

/** Adapter contract shared by the OpenClaw bridge and the DSH v1 service. */
export function createOpenClawAdapter({
  sessionFor,
  capabilities = {},
  models,
  quota,
  inputBudget,
  events,
  agentMap,
  roleMap,
  roles,
} = {}) {
  if (typeof sessionFor !== 'function') throw new Error('sessionFor is required')
  const sessions = new Map()
  const eventProjections = new Map()
  const eventProjectionFor = (bindingKey, nativeRunId) => {
    const key = `${bindingKey}:${nativeRunId ?? '__unknown__'}`
    let projection = eventProjections.get(key)
    if (!projection) {
      projection = { byNativeKey: new Map(), nextSeq: 0 }
      eventProjections.set(key, projection)
    }
    return projection
  }

  const resolveSession = async ({ bindingKey, target, recoverOnly }) => {
    const identity = resolveOpenClawTarget(target, { agentMap, roleMap, roles })
    if (!identity) return { identity: null, session: null }

    const existing = sessions.get(bindingKey)
    if (existing) {
      if (!sameAgentIdentity(existing.identity, identity)) {
        return { identity, session: null, identityMismatch: true }
      }
      return { identity, session: existing.session }
    }

    let session
    try {
      session = await sessionFor({
        bindingKey,
        target: identity.target,
        dshAgentId: identity.dshAgentId,
        mainAgent: identity.mainAgent,
        role: identity.role,
        recoverOnly,
      })
    } catch (error) {
      return { identity, session: null, error }
    }

    if (session && !recoverOnly) sessions.set(bindingKey, { identity, session })
    return { identity, session }
  }

  const adapter = {
    async ensureSession({ bindingKey, target, recoverOnly = false }) {
      const resolved = await resolveSession({ bindingKey, target, recoverOnly })
      if (resolved.error) {
        if (isOpenClawUnknownError(resolved.error)) return unknownSession(bindingKey)
        throw resolved.error
      }
      const session = resolved.session
      if (!session || resolved.identityMismatch) return unknownSession(bindingKey)

      try {
        if (typeof session.start === 'function' && !nativeSessionId(session) && !recoverOnly) {
          await session.start()
        }
      } catch (error) {
        if (isOpenClawUnknownError(error)) return unknownSession(bindingKey)
        throw error
      }

      const id = nativeSessionId(session)
      if (!id || hasRestartSignal(session)) return unknownSession(bindingKey)
      return { bindingKey, status: 'ready', nativeSessionId: id }
    },

    async startTurn({ requestId, bindingKey, nativeSessionId: requestedSessionId, target, message, handoff, attachments = [] }) {
      const resolved = await resolveSession({ bindingKey, target, recoverOnly: true })
      const sessionId = requestedSessionId
      if (resolved.error || !resolved.session || resolved.identityMismatch || !sessionId) {
        return unknownTurn(requestId, sessionId)
      }
      if (nativeSessionId(resolved.session) && nativeSessionId(resolved.session) !== sessionId) {
        return unknownTurn(requestId, sessionId)
      }
      if (hasRestartSignal(resolved.session)) return unknownTurn(requestId, sessionId)
      if (typeof resolved.session.startTurn !== 'function') return unknownTurn(requestId, sessionId)

      const input = runtimeInput({
        requestId,
        bindingKey,
        nativeSessionId: sessionId,
        target: resolved.identity.target,
        mainAgent: resolved.identity.mainAgent,
        role: resolved.identity.role,
        handoff,
        attachments,
      })

      let raw
      try {
        // Keep the legacy two-argument call shape and raw message intact. The
        // legacy bridge owns handoff formatting and accepts these options.
        raw = await resolved.session.startTurn(message, input)
      } catch (error) {
        if (isOpenClawUnknownError(error)) return unknownTurn(requestId, sessionId)
        throw error
      }

      return normalizeTurnResult(raw, {
        requestId,
        sessionId,
        expectedRunId: null,
        session: resolved.session,
        requireRunId: true,
      })
    },

    async interruptTurn({ requestId, bindingKey, nativeSessionId: requestedSessionId, nativeRunId: requestedRunId, target }) {
      const resolved = await resolveSession({ bindingKey, target, recoverOnly: true })
      const sessionId = requestedSessionId ?? nativeSessionId(resolved.session)
      if (resolved.error || !resolved.session || resolved.identityMismatch || !sessionId || !requestedRunId) {
        return unknownInterrupt(requestId, sessionId, requestedRunId)
      }
      if (nativeSessionId(resolved.session) && nativeSessionId(resolved.session) !== sessionId) {
        return unknownInterrupt(requestId, sessionId, requestedRunId)
      }
      if (nativeRunId(resolved.session) && nativeRunId(resolved.session) !== requestedRunId) {
        return unknownInterrupt(requestId, sessionId, requestedRunId)
      }
      if (hasRestartSignal(resolved.session)) return unknownInterrupt(requestId, sessionId, requestedRunId)

      const interrupt = resolved.session.interrupt ?? resolved.session.cancel
      if (typeof interrupt !== 'function') return unknownInterrupt(requestId, sessionId, requestedRunId)

      const input = runtimeInput({
        requestId,
        bindingKey,
        nativeSessionId: sessionId,
        nativeRunId: requestedRunId,
        target: resolved.identity.target,
        mainAgent: resolved.identity.mainAgent,
        role: resolved.identity.role,
      })

      let raw
      try {
        raw = await interrupt.call(resolved.session, input)
      } catch (error) {
        if (isOpenClawUnknownError(error)) return unknownInterrupt(requestId, sessionId, requestedRunId)
        throw error
      }

      const accepted = raw === true || raw?.accepted === true
      const rawTurn = raw?.turn ?? raw
      const hasExplicitOutcome = rawTurn && typeof rawTurn === 'object' && (rawTurn.status !== undefined || rawTurn.state !== undefined || hasRestartSignal(rawTurn))
      const observed = normalizeTurnResult(rawTurn, {
        requestId,
        sessionId,
        expectedRunId: requestedRunId,
        session: resolved.session,
        requireRunId: true,
        fallbackStatus: accepted ? 'stopping' : 'unknown',
      })
      return {
        requestId,
        accepted,
        turn: accepted && observed.status === 'unknown' && !hasExplicitOutcome
          ? { ...unknownTurn(requestId, sessionId, requestedRunId), status: 'stopping' }
          : observed,
      }
    },

    async readEvents(input) {
      const resolved = await resolveSession({ bindingKey: input.bindingKey, target: input.target, recoverOnly: true })
      const sessionId = input.nativeSessionId
      const runId = input.nativeRunId
      if (resolved.error || !resolved.session || resolved.identityMismatch || !sessionId || !runId) {
        return { events: [], turn: unknownTurn(input.requestId, sessionId, runId) }
      }
      if (nativeSessionId(resolved.session) && nativeSessionId(resolved.session) !== sessionId) {
        return { events: [], turn: unknownTurn(input.requestId, sessionId, runId) }
      }
      if (hasRestartSignal(resolved.session)) {
        return { events: [], turn: unknownTurn(input.requestId, sessionId, runId) }
      }

      let raw
      try {
        raw = typeof events === 'function'
          ? await events({
              ...input,
              afterSeq: 0,
              target: resolved.identity.target,
              mainAgent: resolved.identity.mainAgent,
              role: resolved.identity.role,
              session: resolved.session,
            })
          : { events: Array.isArray(resolved.session.events) ? resolved.session.events : [] }
      } catch (error) {
        if (isOpenClawUnknownError(error)) return { events: [], turn: unknownTurn(input.requestId, sessionId, runId) }
        throw error
      }

      const page = Array.isArray(raw) ? { events: raw } : raw ?? { events: [] }
      const normalizedEvents = (page.events ?? [])
        .map((event, index) => normalizeEvent(event, index + 1))
        .map(event => event.nativeRunId ? event : { ...event, nativeRunId: runId })
      const projection = eventProjectionFor(input.bindingKey, runId)
      const projected = projectEvents(projection, normalizedEvents, input.afterSeq ?? 0, runId)
      const observed = page.turn ?? await observeTurn(resolved.session, runtimeInput({
        ...input,
        nativeSessionId: sessionId,
        nativeRunId: runId,
        target: resolved.identity.target,
        mainAgent: resolved.identity.mainAgent,
        role: resolved.identity.role,
      }))
      const turn = normalizeTurnResult(observed, {
        requestId: input.requestId,
        sessionId,
        expectedRunId: runId,
        session: resolved.session,
        requireRunId: true,
      })
      turn.lastEventSeq = projection.nextSeq
      return { events: projected.events, turn }
    },

    async getTurn(input) {
      const resolved = await resolveSession({ bindingKey: input.bindingKey, target: input.target, recoverOnly: true })
      const sessionId = input.nativeSessionId
      const runId = input.nativeRunId
      if (resolved.error || !resolved.session || resolved.identityMismatch || !sessionId || !runId) {
        return unknownTurn(input.requestId, sessionId, runId)
      }
      if (nativeSessionId(resolved.session) && nativeSessionId(resolved.session) !== sessionId) {
        return unknownTurn(input.requestId, sessionId, runId)
      }
      if (hasRestartSignal(resolved.session)) return unknownTurn(input.requestId, sessionId, runId)

      try {
        const observed = await observeTurn(resolved.session, runtimeInput({
          ...input,
          nativeSessionId: sessionId,
          nativeRunId: runId,
          target: resolved.identity.target,
          mainAgent: resolved.identity.mainAgent,
          role: resolved.identity.role,
        }))
        const result = normalizeTurnResult(observed, {
          requestId: input.requestId,
          sessionId,
          expectedRunId: runId,
          session: resolved.session,
          requireRunId: true,
        })
        result.lastEventSeq = eventProjectionFor(input.bindingKey, runId).nextSeq
        return result
      } catch (error) {
        if (isOpenClawUnknownError(error)) return unknownTurn(input.requestId, sessionId, runId)
        throw error
      }
    },

    async listModels() {
      return typeof models === 'function' ? models() : { models: [], observedAt: new Date().toISOString() }
    },
    async getQuota() {
      return typeof quota === 'function' ? quota() : null
    },
    async getInputBudget(input) {
      return typeof inputBudget === 'function'
        ? inputBudget(input)
        : { nativeAvailableInputTokens: null, reservedOutputTokens: null, nativeCompactionSupported: false, admission: 'unverified', observedAt: new Date().toISOString() }
    },
    async cancel(input) {
      return this.interruptTurn(input)
    },
    capabilities,
  }
  return adapter
}

export default createOpenClawAdapter

function lookupMapping(source, agentId, target) {
  if (typeof source === 'function') return source(agentId, target)
  if (source && typeof source === 'object') return source[agentId]
  return undefined
}

function normalizeMapping(value) {
  if (typeof value === 'string' && value.trim()) return { mainAgent: value.trim() }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const mainAgent = normalizeText(value.mainAgent ?? value.nativeAgent ?? value.agent)
  const role = normalizeRole(value.role)
  return mainAgent || role ? { ...(mainAgent ? { mainAgent } : {}), ...(role ? { role } : {}) } : undefined
}

function legacyMainAgent(agentId) {
  if (agentId === 'openclaw') return agentId
  if (agentId.startsWith('openclaw.')) return agentId.slice('openclaw.'.length) || null
  return agentId
}

function normalizeText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function normalizeRole(value) {
  return normalizeText(value)
}

function sameAgentIdentity(left, right) {
  return left.dshAgentId === right.dshAgentId && left.mainAgent === right.mainAgent && left.role === right.role
}

function runtimeInput(input) {
  return { ...input, target: input.target, mainAgent: input.mainAgent, role: input.role }
}

function nativeSessionId(value) {
  return normalizeText(value?.nativeSessionId ?? value?.sessionId ?? value?.threadId ?? value?.identity?.sessionId)
}

function nativeRunId(value) {
  return normalizeText(value?.nativeRunId ?? value?.runId ?? value?.turnId ?? value?.currentRunId ?? value?.id)
}

function unwrapRuntimeResult(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return value.turn ?? value.run ?? value
}

function unknownSession(bindingKey) {
  return { bindingKey, status: 'unknown', nativeSessionId: null }
}

function unknownTurn(requestId, nativeSessionIdValue = null, nativeRunIdValue = null) {
  return {
    requestId,
    nativeSessionId: nativeSessionIdValue ?? null,
    nativeRunId: nativeRunIdValue ?? null,
    status: 'unknown',
    lastEventSeq: 0,
  }
}

function unknownInterrupt(requestId, nativeSessionIdValue = null, nativeRunIdValue = null) {
  return { requestId, accepted: false, turn: unknownTurn(requestId, nativeSessionIdValue, nativeRunIdValue) }
}

function normalizeTurnResult(value, { requestId, sessionId, expectedRunId, session, requireRunId, fallbackStatus = 'unknown' }) {
  const record = unwrapRuntimeResult(value)
  if (!record || typeof record !== 'object' || Array.isArray(record)) return unknownTurn(requestId, sessionId, expectedRunId)

  const observedSessionId = nativeSessionId(record)
  const observedRunId = nativeRunId(record) ?? expectedRunId ?? nativeRunId(session)
  if (observedSessionId && observedSessionId !== sessionId) return unknownTurn(requestId, sessionId, null)
  if (expectedRunId && observedRunId && observedRunId !== expectedRunId) return unknownTurn(requestId, sessionId, expectedRunId)
  if (hasRestartSignal(record)) return unknownTurn(requestId, sessionId, expectedRunId ?? observedRunId)
  if (requireRunId && !observedRunId) return unknownTurn(requestId, sessionId, null)

  const hasExplicitStatus = record.status !== undefined || record.state !== undefined
  const status = normalizeOpenClawStatus(record.status ?? record.state ?? fallbackStatus)
  const result = {
    requestId,
    nativeSessionId: sessionId ?? observedSessionId ?? null,
    nativeRunId: observedRunId ?? null,
    status: status === 'unknown' && !hasExplicitStatus ? normalizeOpenClawStatus(fallbackStatus) : status,
    lastEventSeq: readSequence(record),
  }
  const output = record.output ?? record.finalText ?? record.text
  if (typeof output === 'string') result.output = output
  return result
}

async function observeTurn(session, input) {
  if (typeof session.getTurn === 'function') return session.getTurn(input)
  if (typeof session.observeTurn === 'function') return session.observeTurn(input)
  if (typeof session.getRun === 'function') return session.getRun(input)
  return undefined
}

function readSequence(value) {
  const sequence = value?.lastEventSeq ?? value?.sequence ?? value?.seq ?? value?.nextCursor
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : 0
}

function projectEvents(projection, nativeEvents, afterSeq, nativeRunId) {
  const projected = []
  for (const event of (Array.isArray(nativeEvents) ? nativeEvents : [])
    .filter(value => value?.nativeRunId === nativeRunId)
    .sort((left, right) => left.seq - right.seq)) {
    const key = event.nativeEventId ?? `${event.seq}:${event.type}:${JSON.stringify(event.payload)}`
    let seq = projection.byNativeKey.get(key)
    if (seq === undefined) {
      seq = projection.nextSeq + 1
      projection.nextSeq = seq
      projection.byNativeKey.set(key, seq)
    }
    if (seq > afterSeq) {
      projected.push({ seq, type: event.type, payload: { ...event.payload, nativeSeq: event.seq, nativeType: event.type } })
    }
  }
  return { events: projected, nextSeq: projection.nextSeq }
}

function normalizeEvent(event, fallbackSeq) {
  const value = event && typeof event === 'object' ? event : {}
  const payload = value.payload ?? value.data ?? {}
  const eventRunId = normalizeText(value.nativeRunId ?? value.runId ?? value.turnId) ?? normalizeText(payload.nativeRunId ?? payload.runId ?? payload.turnId)
  return {
    seq: readEventSequence(value, fallbackSeq),
    type: typeof value.type === 'string' && value.type ? value.type : 'status',
    payload: payload && typeof payload === 'object' ? payload : {},
    nativeRunId: eventRunId,
  }
}

function readEventSequence(value, fallbackSeq) {
  const sequence = value.seq ?? value.sequence ?? fallbackSeq
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : fallbackSeq
}

function hasRestartSignal(value) {
  if (!value || typeof value !== 'object') return false
  if (value.queueRestarted === true || value.gatewayRestarted === true || value.restarting === true || value.disconnected === true) return true
  if (value.deliveryState === 'unknown' || value.state === 'restarting' || value.status === 'restarting') return true
  if (typeof value.status === 'string' && value.status.toLowerCase().includes('restart')) return true
  if (typeof value.state === 'string' && value.state.toLowerCase().includes('restart')) return true
  for (const field of ['queueState', 'gatewayState', 'transportState']) {
    const state = String(value[field] ?? '').toLowerCase()
    if (state.includes('restart') || state.includes('disconnect') || state.includes('lost')) return true
  }
  return false
}
