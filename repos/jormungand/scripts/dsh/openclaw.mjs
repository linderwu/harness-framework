/** Adapter contract shared by the OpenClaw bridge and the DSH v1 service. */
export function createOpenClawAdapter({ sessionFor, capabilities = {}, models, quota, inputBudget, events }) {
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
      if (typeof session.start === 'function' && !session.nativeSessionId && !recoverOnly) await session.start()
      return { bindingKey, status: 'ready', nativeSessionId: session.nativeSessionId ?? session.threadId ?? null }
    },
    async startTurn({ requestId, bindingKey, nativeSessionId, target, message, handoff, attachments }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session?.startTurn) return { requestId, nativeSessionId, nativeRunId: null, status: 'unknown', lastEventSeq: 0 }
      return session.startTurn(message, { requestId, bindingKey, nativeSessionId, target, handoff, attachments })
    },
    async interruptTurn({ requestId, bindingKey, nativeSessionId, nativeRunId, target }) {
      const session = await resolveSession({ bindingKey, target, recoverOnly: true })
      if (!session?.interrupt) return { requestId, accepted: false, turn: { requestId, nativeSessionId, nativeRunId, status: 'unknown', lastEventSeq: 0 } }
      return session.interrupt({ requestId, nativeSessionId, nativeRunId })
    },
    async readEvents(input) {
      const session = await resolveSession({ bindingKey: input.bindingKey, target: input.target, recoverOnly: true })
      return session && typeof events === 'function' ? events({ ...input, session }) : { events: [] }
    },
    async getTurn(input) {
      const session = await resolveSession({ bindingKey: input.bindingKey, target: input.target, recoverOnly: true })
      return session?.getTurn ? session.getTurn(input) : null
    },
    async listModels() { return typeof models === 'function' ? models() : { models: [], observedAt: new Date().toISOString() } },
    async getQuota() { return typeof quota === 'function' ? quota() : null },
    async getInputBudget(input) { return typeof inputBudget === 'function' ? inputBudget(input) : { nativeAvailableInputTokens: null, reservedOutputTokens: null, nativeCompactionSupported: false, admission: 'unverified', observedAt: new Date().toISOString() } },
    capabilities,
  }
}

export default createOpenClawAdapter
