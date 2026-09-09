import { formatHandoffPrompt } from './input.mjs'

export function createCodexAdapter({ sessionFor, capabilities = {}, models, quota, inputBudget, events }) {
  if (typeof sessionFor !== 'function') throw new Error('sessionFor is required')
  const sessions = new Map()
  const resolveSession = async ({ bindingKey, target, recoverOnly }) => {
    if (sessions.has(bindingKey)) return sessions.get(bindingKey)
    const session = await sessionFor({ bindingKey, target, recoverOnly })
    if (session && !recoverOnly) sessions.set(bindingKey, session)
    return session
  }
  return {
    async ensureSession({ bindingKey, target, recoverOnly = false }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly })
      if (!session) return { bindingKey, status: 'unknown', nativeSessionId: null }
      if (typeof session.start === 'function' && !session.threadId && !recoverOnly) await session.start()
      return { bindingKey, status: 'ready', nativeSessionId: session.threadId ?? session.nativeSessionId ?? null }
    },
    async startTurn({ requestId, bindingKey, nativeSessionId, target, message, handoff = null, attachments = [] }) {
      if (target.modelId && typeof models === 'function') {
        const catalog = await models()
        const entries = Array.isArray(catalog?.models) ? catalog.models : []
        if (entries.length > 0 && !entries.some((entry) => (typeof entry === 'string' ? entry : entry?.id) === target.modelId)) {
          const error = new Error(`model ${target.modelId} is not available on the native bridge`)
          error.code = 'INVALID_MODEL'
          error.httpStatus = 422
          throw error
        }
      }
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session || typeof session.startTurn !== 'function') return { requestId, nativeSessionId, nativeRunId: null, status: 'unknown', lastEventSeq: 0 }
      const turn = await session.startTurn(formatHandoffPrompt(message, handoff), { modelId: target.modelId, reasoningEffort: target.reasoningEffort, handoff, attachments })
      return { requestId, nativeSessionId: nativeSessionId ?? session.threadId ?? null, nativeRunId: turn.id ?? null, status: turn.status === 'completed' ? 'completed' : 'running', lastEventSeq: 0 }
    },
    async interruptTurn({ requestId, bindingKey, nativeSessionId, nativeRunId, target }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session || typeof session.interrupt !== 'function') return { requestId, accepted: false, turn: { requestId, nativeSessionId, nativeRunId, status: 'unknown', lastEventSeq: 0 } }
      const accepted = await session.interrupt(nativeRunId)
      return { requestId, accepted: accepted !== false, turn: { requestId, nativeSessionId, nativeRunId, status: accepted === false ? 'unknown' : 'stopping', lastEventSeq: 0 } }
    },
    async readEvents({ requestId, bindingKey, target, afterSeq = 0, nativeRunId }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session) return { events: [] }
      if (typeof events === 'function') return events({ requestId, session, afterSeq, nativeRunId })
      const nativeEvents = Array.isArray(session.events) ? session.events : []
      return {
        events: nativeEvents
          .filter((event) => (event.sequence ?? event.seq ?? 0) > afterSeq)
          .map((event) => ({ seq: event.seq ?? event.sequence, type: event.type, payload: event.payload ?? event.data ?? {} })),
        turn: await this.getTurn?.({ requestId, bindingKey, target, nativeRunId, nativeSessionId: session.threadId ?? session.nativeSessionId }),
      }
    },
    async getTurn({ requestId, bindingKey, target, nativeRunId, nativeSessionId }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session) return null
      const status = session.turnStatus === 'inProgress'
        ? 'running'
        : session.turnStatus === 'interrupted'
          ? 'interrupted'
          : session.turnStatus === 'completed'
            ? 'completed'
            : session.turnStatus === 'failed'
              ? 'failed'
              : undefined
      return status ? { requestId, nativeSessionId: nativeSessionId ?? session.threadId ?? null, nativeRunId: nativeRunId ?? session.currentTurnId ?? null, status, lastEventSeq: 0, output: session.finalText } : null
    },
    async listModels() { return typeof models === 'function' ? models() : { models: [], observedAt: new Date().toISOString() } },
    async getQuota() { return typeof quota === 'function' ? quota() : null },
    async getInputBudget(input) { return typeof inputBudget === 'function' ? inputBudget(input) : { nativeAvailableInputTokens: null, reservedOutputTokens: null, nativeCompactionSupported: false, admission: 'unverified', observedAt: new Date().toISOString() } },
    capabilities,
  }
}
