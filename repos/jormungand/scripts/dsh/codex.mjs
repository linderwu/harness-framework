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
    async startTurn({ requestId, bindingKey, nativeSessionId, target, message }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session || typeof session.startTurn !== 'function') return { requestId, nativeSessionId, nativeRunId: null, status: 'unknown', lastEventSeq: 0 }
      const turn = await session.startTurn(message, { modelId: target.modelId, reasoningEffort: target.reasoningEffort })
      return { requestId, nativeSessionId: nativeSessionId ?? session.threadId ?? null, nativeRunId: turn.id ?? null, status: turn.status === 'completed' ? 'completed' : 'running', lastEventSeq: 0 }
    },
    async interruptTurn({ requestId, bindingKey, nativeSessionId, nativeRunId, target }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session || typeof session.interrupt !== 'function') return { requestId, accepted: false, turn: { requestId, nativeSessionId, nativeRunId, status: 'unknown', lastEventSeq: 0 } }
      await session.interrupt(nativeRunId)
      return { requestId, accepted: true, turn: { requestId, nativeSessionId, nativeRunId, status: 'stopping', lastEventSeq: 0 } }
    },
    async readEvents({ requestId, bindingKey, target, afterSeq = 0, nativeRunId }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session || typeof events !== 'function') return { events: [] }
      return events({ requestId, session, afterSeq, nativeRunId })
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
