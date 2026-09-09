import { spawn } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { formatHandoffPrompt } from './input.mjs'

function piError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

/**
 * Small JSONL RPC adapter for Pi. It intentionally keeps the subprocess
 * behind the same v1 receipt/event contract as the other bridges.
 */
export function createPiAdapter({ command = 'pi', cwdFor, spawnImpl = spawn, capabilities = {} } = {}) {
  const sessions = new Map()
  const resolveCwd = (target) => typeof cwdFor === 'function' ? cwdFor(target) : process.cwd()

  function createSession(bindingKey, target) {
    const child = spawnImpl(command, ['--mode', 'rpc'], { cwd: resolveCwd(target), stdio: ['pipe', 'pipe', 'pipe'] })
    const session = {
      nativeSessionId: `pi:${bindingKey}`,
      child,
      sequence: 0,
      events: [],
      status: 'ready',
      turnStatus: 'idle',
      currentRequestId: null,
      currentRunId: null,
      buffer: '',
      pending: new Map(),
      decoder: new StringDecoder('utf8'),
    }
    const append = (type, payload = {}) => {
      session.sequence += 1
      session.events.push({ seq: session.sequence, type, payload })
      if (session.events.length > 2000) session.events.shift()
    }
    child.stdout.on('data', (chunk) => {
      session.buffer += session.decoder.write(chunk)
      const lines = session.buffer.split('\n')
      session.buffer = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) processLine(session, line)
    })
    child.on('close', (code) => {
      session.buffer += session.decoder.end()
      if (session.buffer.trim()) {
        try { processLine(session, session.buffer) } catch { append('status', { message: 'Pi emitted an incomplete JSON frame.' }) }
      }
      if (session.turnStatus === 'running' || session.turnStatus === 'stopping') session.turnStatus = code === 0 ? 'unknown' : 'failed'
      session.status = code === 0 ? 'stopped' : 'failed'
      append('status', { status: session.turnStatus, exitCode: code })
    })
    sessions.set(bindingKey, session)
    return session

    function processLine(activeSession, line) {
      let event
      try { event = JSON.parse(line) } catch { append('status', { message: 'Pi emitted malformed JSON.' }); return }
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent ?? {}
        if (update.type === 'text_delta') append('text_delta', { text: update.delta ?? '', nativeType: update.type })
        else append('status', { nativeType: update.type })
      } else if (event.type === 'tool_execution_start') {
        append('tool_started', { nativeBlockId: event.toolCallId, message: event.toolName })
      } else if (event.type === 'tool_execution_end') {
        append('tool_finished', { nativeBlockId: event.toolCallId, message: event.toolName })
      } else if (event.type === 'agent_end') {
        activeSession.turnStatus = activeSession.turnStatus === 'stopping' ? 'interrupted' : 'completed'
        append('status', { status: activeSession.turnStatus, nativeType: event.type })
      } else if (event.type === 'response' && event.command === 'abort') {
        activeSession.turnStatus = 'interrupted'
        append('status', { status: 'interrupted', nativeType: event.type })
      } else {
        append('status', { nativeType: event.type })
      }
    }
  }

  const write = (session, value) => {
    if (session.child.stdin.destroyed) throw piError('PI_UNKNOWN', 'Pi stdin is closed')
    session.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  const adapter = {
    capabilities: {
      sessionResume: false,
      models: false,
      reasoning: false,
      events: true,
      eventReplay: true,
      interrupt: true,
      settledSignal: true,
      attachments: false,
      quota: false,
      ...capabilities,
    },
    async ensureSession({ bindingKey, target, recoverOnly = false }) {
      const existing = sessions.get(bindingKey)
      if (existing) return { bindingKey, status: 'ready', nativeSessionId: existing.nativeSessionId }
      if (recoverOnly) return { bindingKey, status: 'unknown', nativeSessionId: null }
      const session = createSession(bindingKey, target)
      return { bindingKey, status: 'ready', nativeSessionId: session.nativeSessionId }
    },
    async startTurn({ requestId, bindingKey, target, message, handoff = null, attachments = [] }) {
      const session = sessions.get(bindingKey)
      if (!session) return { requestId, nativeSessionId: null, nativeRunId: null, status: 'unknown', lastEventSeq: 0 }
      if (session.turnStatus === 'running' || session.turnStatus === 'stopping') throw piError('PI_BUSY', 'Pi already has an active turn')
      session.currentRequestId = requestId
      session.currentRunId = requestId
      session.turnStatus = 'running'
      appendPrompt(session, target, message, handoff, attachments)
      return { requestId, nativeSessionId: session.nativeSessionId, nativeRunId: requestId, status: 'running', lastEventSeq: session.sequence }
    },
    async interruptTurn({ requestId, bindingKey, nativeSessionId, nativeRunId }) {
      const session = sessions.get(bindingKey)
      if (!session || session.nativeSessionId !== nativeSessionId || session.currentRunId !== nativeRunId) return { requestId, accepted: false, turn: { requestId, nativeSessionId, nativeRunId, status: 'unknown', lastEventSeq: 0 } }
      if (session.turnStatus !== 'running') return { requestId, accepted: false, turn: getTurn(session, requestId) }
      session.turnStatus = 'stopping'
      write(session, { type: 'abort' })
      return { requestId, accepted: true, turn: getTurn(session, requestId) }
    },
    async readEvents({ requestId, bindingKey, afterSeq = 0 }) {
      const session = sessions.get(bindingKey)
      if (!session) return { events: [] }
      return { events: session.events.filter((event) => event.seq > afterSeq), turn: getTurn(session, requestId) }
    },
    async getTurn({ requestId, bindingKey }) {
      const session = sessions.get(bindingKey)
      return session ? getTurn(session, requestId) : null
    },
    async listModels() { return { models: [], observedAt: new Date().toISOString() } },
    async getQuota() { return null },
    async getInputBudget() { return { nativeAvailableInputTokens: null, reservedOutputTokens: null, nativeCompactionSupported: false, admission: 'unverified', observedAt: new Date().toISOString() } },
  }
  return adapter

  function appendPrompt(session, target, message, handoff, attachments) {
    if (target.modelId) {
      const [provider, modelId] = target.modelId.includes(':') ? target.modelId.split(':', 2) : ['', target.modelId]
      write(session, { type: 'set_model', provider, modelId })
    }
    write(session, { type: 'prompt', message: formatHandoffPrompt(message, handoff), ...(attachments.length ? { attachments } : {}) })
  }
}

function getTurn(session, requestId) {
  const status = session.turnStatus === 'running' ? 'running' : session.turnStatus === 'stopping' ? 'stopping' : session.turnStatus === 'completed' ? 'completed' : session.turnStatus === 'interrupted' ? 'interrupted' : session.turnStatus === 'failed' ? 'failed' : 'unknown'
  return { requestId, nativeSessionId: session.nativeSessionId, nativeRunId: session.currentRunId, status, lastEventSeq: session.sequence }
}

export default createPiAdapter
