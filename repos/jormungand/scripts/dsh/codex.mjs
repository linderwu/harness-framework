import { formatHandoffPrompt } from './input.mjs'

const RUNNING_NATIVE_STATUSES = new Set(['inProgress', 'running', 'queued', 'submitted'])

function adapterError(code, message) {
  const error = new Error(message)
  error.code = code
  error.httpStatus = 422
  return error
}

function nativeId(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}



function sessionNativeId(session) {
  const threadId = nativeId(session?.threadId)
  const otherId = nativeId(session?.nativeSessionId)
  if (threadId && otherId && threadId !== otherId) return null
  return threadId ?? otherId
}

function normalizeTurnStatus(status) {
  if (RUNNING_NATIVE_STATUSES.has(status)) return 'running'
  if (status === 'stopping') return 'stopping'
  if (status === 'completed') return 'completed'
  if (status === 'interrupted' || status === 'canceled' || status === 'cancelled' || status === 'aborted') return 'interrupted'
  if (status === 'failed' || status === 'error') return 'failed'
  return 'unknown'
}

function unknownTurn({ requestId, nativeSessionId = null, nativeRunId = null, lastEventSeq = 0 }) {
  return { requestId, nativeSessionId: nativeSessionId ?? null, nativeRunId: nativeRunId ?? null, status: 'unknown', lastEventSeq }
}

function observedTurn(value, { requestId, nativeSessionId, nativeRunId, lastEventSeq }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return unknownTurn({ requestId, nativeSessionId, nativeRunId, lastEventSeq })
  const observedSessionId = nativeId(value.nativeSessionId ?? value.sessionId ?? value.threadId)
  const observedRunId = nativeId(value.nativeRunId ?? value.runId ?? value.turnId ?? value.id)
  if ((observedSessionId && observedSessionId !== nativeSessionId) || (observedRunId && observedRunId !== nativeRunId)) {
    return unknownTurn({ requestId, nativeSessionId, nativeRunId, lastEventSeq })
  }
  const output = value.output ?? value.finalText
  return {
    requestId,
    nativeSessionId,
    nativeRunId,
    status: normalizeTurnStatus(value.status ?? value.state),
    lastEventSeq,
    ...(typeof output === 'string' ? { output } : {}),
  }
}

function eventRunId(event) {
  return nativeId(event?.turnId)
    ?? nativeId(event?.nativeRunId)
    ?? nativeId(event?.payload?.turnId)
    ?? nativeId(event?.payload?.nativeRunId)
    ?? nativeId(event?.data?.turnId)
    ?? nativeId(event?.data?.nativeRunId)
}

function belongsToRun(event, nativeRunId) {
  if (!nativeRunId) return true
  const eventRun = eventRunId(event)
  return eventRun === nativeRunId
}

function eventPayload(event) {
  const payload = event?.payload && typeof event.payload === 'object' ? { ...event.payload } : event?.data && typeof event.data === 'object' ? { ...event.data } : {}
  if (event?.id !== undefined) payload.nativeEventId ??= event.id
  if (event?.type !== undefined) payload.nativeType ??= event.type
  const runId = eventRunId(event)
  if (runId) payload.nativeRunId ??= runId
  if (event?.itemId !== undefined) payload.nativeBlockId ??= event.itemId
  if (event?.text !== undefined) payload.text ??= event.text
  if (event?.message !== undefined) payload.message ??= event.message
  return payload
}

function projectionKey(event) {
  const nativeSequence = Number(event?.sequence ?? event?.seq)
  const nativeEventId = nativeId(event?.id)
  return nativeEventId ?? `${nativeSequence}:${event?.type ?? ''}:${JSON.stringify(eventPayload(event))}`
}

function projectEvents(projection, nativeEvents, afterSeq, nativeRunId) {
  const projected = []
  for (const event of (Array.isArray(nativeEvents) ? nativeEvents : [])
    .map(value => ({ value, nativeSeq: Number(value?.sequence ?? value?.seq) }))
    .filter(({ value, nativeSeq }) => Number.isSafeInteger(nativeSeq) && belongsToRun(value, nativeRunId))
    .sort((left, right) => left.nativeSeq - right.nativeSeq)) {
    const key = projectionKey(event.value)
    let seq = projection.byNativeKey.get(key)
    if (seq === undefined) {
      seq = projection.nextSeq + 1
      projection.nextSeq = seq
      projection.byNativeKey.set(key, seq)
    }
    if (seq > afterSeq) {
      projected.push({ seq, type: event.value.type, payload: { ...eventPayload(event.value), nativeSeq: event.nativeSeq } })
    }
  }
  return { events: projected, nextSeq: projection.nextSeq }
}

function modelIdOf(entry) {
  if (typeof entry === 'string') return entry
  return String(entry?.id ?? entry?.model ?? '').trim()
}

function supportedEffortsOf(entry) {
  const values = entry?.supportedReasoningEfforts ?? entry?.reasoningEfforts ?? entry?.supportedEfforts
  if (!Array.isArray(values)) return []
  return values
    .map(value => typeof value === 'string' ? value : value?.reasoningEffort)
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
}

export function createCodexAdapter({ sessionFor, capabilities = {}, models, quota, inputBudget, events }) {
  if (typeof sessionFor !== 'function') throw new Error('sessionFor is required')
  const sessions = new Map()
  const rememberedSessionIds = new Map()
  const rememberedRunIds = new Map()
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
    if (sessions.has(bindingKey)) return sessions.get(bindingKey)
    const session = await sessionFor({ bindingKey, target, recoverOnly })
    if (session) sessions.set(bindingKey, session)
    return session
  }

  const resolveNativeSessionId = (bindingKey, session) => {
    const observed = sessionNativeId(session)
    const remembered = rememberedSessionIds.get(bindingKey)
    if (observed && remembered && observed !== remembered) return null
    return observed ?? remembered
  }

  const rememberNativeSessionId = (bindingKey, session, candidate) => {
    const observed = sessionNativeId(session)
    const resolved = observed ?? nativeId(candidate)
    if (resolved) rememberedSessionIds.set(bindingKey, resolved)
    return resolved
  }

  const resolveNativeRunId = (bindingKey, session) => {
    const observed = nativeId(session?.currentTurnId)
    const remembered = rememberedRunIds.get(bindingKey)
    if (observed && remembered && observed !== remembered) return null
    return observed ?? remembered
  }

  const validateSelection = async target => {
    const modelId = nativeId(target?.modelId)
    const reasoningEffort = nativeId(target?.reasoningEffort)
    if (reasoningEffort && !modelId) throw adapterError('INVALID_REASONING_EFFORT', 'reasoning effort requires an exact native model')
    if (!modelId || typeof models !== 'function') return

    const catalog = await models()
    const entries = Array.isArray(catalog) ? catalog : Array.isArray(catalog?.models) ? catalog.models : []
    if (entries.length === 0) {
      if (reasoningEffort) throw adapterError('INVALID_REASONING_EFFORT', `reasoning metadata is unavailable for model ${modelId}`)
      return
    }
    const model = entries.find(entry => modelIdOf(entry) === modelId)
    if (!model) throw adapterError('INVALID_MODEL', `model ${modelId} is not available on the native bridge`)
    const supportedEfforts = supportedEffortsOf(model)
    if (reasoningEffort && (supportedEfforts.length === 0 || !supportedEfforts.includes(reasoningEffort))) {
      throw adapterError('INVALID_REASONING_EFFORT', `reasoning effort ${reasoningEffort} is not available for model ${modelId}`)
    }
  }

  const adapter = {
    async ensureSession({ bindingKey, target, recoverOnly = false }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly })
      if (!session) return { bindingKey, status: 'unknown', nativeSessionId: null }

      let resolved = resolveNativeSessionId(bindingKey, session)
      if (!resolved && typeof session.start === 'function' && !recoverOnly) {
        let started
        try {
          started = await session.start()
        } catch {
          return { bindingKey, status: 'unknown', nativeSessionId: resolveNativeSessionId(bindingKey, session) }
        }
        resolved = rememberNativeSessionId(bindingKey, session, started?.threadId ?? started?.nativeSessionId)
      } else if (resolved) {
        rememberedSessionIds.set(bindingKey, resolved)
      }

      if (!resolved) return { bindingKey, status: 'unknown', nativeSessionId: null }
      return { bindingKey, status: 'ready', nativeSessionId: resolved }
    },

    async startTurn({ requestId, bindingKey, nativeSessionId, target, message, handoff = null, attachments = [] }) {
      await validateSelection(target)
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      const actualNativeSessionId = resolveNativeSessionId(bindingKey, session)
      if (!session || !actualNativeSessionId || nativeSessionId !== actualNativeSessionId) {
        return unknownTurn({ requestId, nativeSessionId, lastEventSeq: 0 })
      }
      if (typeof session.startTurn !== 'function') return unknownTurn({ requestId, nativeSessionId: actualNativeSessionId, lastEventSeq: 0 })

      let turn
      try {
        turn = await session.startTurn(formatHandoffPrompt(message, handoff), {
          modelId: target?.modelId,
          reasoningEffort: target?.reasoningEffort,
          handoff,
          attachments,
        })
      } catch {
        return unknownTurn({ requestId, nativeSessionId: actualNativeSessionId, lastEventSeq: 0 })
      }

      const nativeRunId = nativeId(turn?.id ?? turn?.nativeRunId ?? turn?.turnId)
      if (!nativeRunId) return unknownTurn({ requestId, nativeSessionId: actualNativeSessionId, lastEventSeq: 0 })
      rememberedRunIds.set(bindingKey, nativeRunId)
      return {
        requestId,
        nativeSessionId: actualNativeSessionId,
        nativeRunId,
        status: normalizeTurnStatus(turn?.status),
        lastEventSeq: 0,
      }
    },

    async interruptTurn({ requestId, bindingKey, nativeSessionId, nativeRunId, target }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      const actualNativeSessionId = resolveNativeSessionId(bindingKey, session)
      const actualNativeRunId = resolveNativeRunId(bindingKey, session)
      if (!session || !actualNativeSessionId || nativeSessionId !== actualNativeSessionId || !nativeRunId || !actualNativeRunId || nativeRunId !== actualNativeRunId) {
        return { requestId, accepted: false, turn: unknownTurn({ requestId, nativeSessionId, nativeRunId, lastEventSeq: 0 }) }
      }

      const currentStatus = normalizeTurnStatus(session.turnStatus)
      if (['completed', 'interrupted', 'failed'].includes(currentStatus)) {
        return { requestId, accepted: false, turn: { requestId, nativeSessionId: actualNativeSessionId, nativeRunId: actualNativeRunId, status: currentStatus, lastEventSeq: 0 } }
      }
      if (typeof session.interrupt !== 'function') {
        return { requestId, accepted: false, turn: unknownTurn({ requestId, nativeSessionId: actualNativeSessionId, nativeRunId, lastEventSeq: 0 }) }
      }

      let accepted
      try {
        accepted = await session.interrupt(nativeRunId)
      } catch {
        return { requestId, accepted: false, turn: unknownTurn({ requestId, nativeSessionId: actualNativeSessionId, nativeRunId, lastEventSeq: 0 }) }
      }
      return {
        requestId,
        accepted: accepted === true,
        turn: {
          requestId,
          nativeSessionId: actualNativeSessionId,
          nativeRunId: actualNativeRunId,
          status: accepted === true ? 'stopping' : 'unknown',
          lastEventSeq: 0,
        },
      }
    },

    async readEvents({ requestId, bindingKey, target, afterSeq = 0, nativeRunId, nativeSessionId }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      const actualNativeSessionId = resolveNativeSessionId(bindingKey, session)
      const actualNativeRunId = resolveNativeRunId(bindingKey, session)
      const cursor = Number.isSafeInteger(Number(afterSeq)) && Number(afterSeq) >= 0 ? Number(afterSeq) : 0
      if (!session) return { events: [] }
      if (!actualNativeSessionId || nativeSessionId !== actualNativeSessionId || !nativeRunId || !actualNativeRunId || nativeRunId !== actualNativeRunId) {
        return { events: [], turn: unknownTurn({ requestId, nativeSessionId, nativeRunId, lastEventSeq: 0 }) }
      }

      const page = typeof events === 'function'
        ? await events({ requestId, session, afterSeq: 0, nativeRunId })
        : { events: session.events }
      const projection = eventProjectionFor(bindingKey, nativeRunId)
      const projected = projectEvents(projection, page?.events, cursor, nativeRunId)
      const observed = page?.turn === undefined
        ? await adapter.getTurn({ requestId, bindingKey, target, nativeRunId, nativeSessionId: actualNativeSessionId })
        : observedTurn(page.turn, {
          requestId,
          nativeSessionId: actualNativeSessionId,
          nativeRunId,
          lastEventSeq: projection.nextSeq,
        })
      if (observed) observed.lastEventSeq = projection.nextSeq
      return { ...(page && !Array.isArray(page) ? page : {}), events: projected.events, turn: observed }
    },

    async getTurn({ requestId, bindingKey, target, nativeRunId, nativeSessionId }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session) return null
      const actualNativeSessionId = resolveNativeSessionId(bindingKey, session)
      const actualNativeRunId = resolveNativeRunId(bindingKey, session)
      if (!actualNativeSessionId || nativeSessionId !== actualNativeSessionId || !nativeRunId || !actualNativeRunId || nativeRunId !== actualNativeRunId) {
        return unknownTurn({ requestId, nativeSessionId, nativeRunId, lastEventSeq: 0 })
      }
      const projection = eventProjectionFor(bindingKey, nativeRunId)
      return {
        requestId,
        nativeSessionId: actualNativeSessionId,
        nativeRunId,
        status: normalizeTurnStatus(session.turnStatus),
        lastEventSeq: projection.nextSeq,
        output: session.finalText,
      }
    },

    async listModels() { return typeof models === 'function' ? models() : { models: [], observedAt: new Date().toISOString() } },
    async getQuota() { return typeof quota === 'function' ? quota() : null },
    async getInputBudget(input) { return typeof inputBudget === 'function' ? inputBudget(input) : { nativeAvailableInputTokens: null, reservedOutputTokens: null, nativeCompactionSupported: false, admission: 'unverified', observedAt: new Date().toISOString() } },
    capabilities,
  }
  return adapter
}
