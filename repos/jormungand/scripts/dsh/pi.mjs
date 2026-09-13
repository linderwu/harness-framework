import { spawn } from 'node:child_process'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { formatHandoffPrompt } from './input.mjs'

function piError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function commandError(event) {
  const message = typeof event.error === 'string'
    ? event.error
    : event.error?.message ?? `Pi rejected ${event.command ?? 'the command'}.`
  const code = event.command === 'set_model' ? 'INVALID_MODEL' : event.command === 'prompt' ? 'PI_PROMPT_REJECTED' : 'PI_COMMAND_REJECTED'
  const error = piError(code, message)
  error.nativeResponse = event
  return error
}

function textFromContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.map((block) => {
    if (typeof block === 'string') return block
    if (block?.type === 'text') return block.text ?? ''
    return ''
  }).join('')
}

function textFromMessage(message) {
  if (!message || (message.role && message.role !== 'assistant')) return ''
  return textFromContent(message.content ?? message.text)
}

function runtimeErrorFromMessage(message) {
  if (!message || typeof message !== 'object') return null
  const raw = [
    message.errorMessage,
    typeof message.error === 'string' ? message.error : message.error?.message,
  ].filter(value => typeof value === 'string' && value.trim()).join(' ')
  if (message.stopReason !== 'error' && !raw) return null
  if (/\b401\b|invalid[_ -]?api[_ -]?key|incorrect api key|credentials?_not_configured/iu.test(raw)) {
    return { code: 'PI_AUTH_FAILED', message: 'Pi provider authentication failed.' }
  }
  return { code: 'PI_RUNTIME_ERROR', message: 'Pi provider returned an error.' }
}

function runtimeErrorFromEvent(event) {
  const direct = runtimeErrorFromMessage(event?.message)
  if (direct) return direct
  if (event?.type === 'agent_end' && Array.isArray(event.messages)) {
    for (let index = event.messages.length - 1; index >= 0; index -= 1) {
      const error = runtimeErrorFromMessage(event.messages[index])
      if (error) return error
    }
  }
  if (event?.errorMessage || event?.error) {
    return runtimeErrorFromMessage({ stopReason: 'error', errorMessage: event.errorMessage, error: event.error })
  }
  return null
}

function finalAssistantText(messages) {
  if (!Array.isArray(messages)) return ''
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const text = textFromMessage(messages[index])
    if (text) return text
  }
  return ''
}

function projectEvents(projection, nativeEvents, afterSeq, nativeRunId) {
  const projected = []
  for (const event of (Array.isArray(nativeEvents) ? nativeEvents : [])
    .filter(value => value?.payload?.nativeRunId === nativeRunId)
    .sort((left, right) => left.seq - right.seq)) {
    const key = `${event.seq}:${event.type}:${JSON.stringify(event.payload)}`
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

/**
 * Small JSONL RPC adapter for Pi. It intentionally keeps the subprocess
 * behind the same v1 receipt/event contract as the other bridges.
 */
export function createPiAdapter({ command = 'pi', provider = 'minimax', model = 'MiniMax-M2.7', cwdFor, spawnImpl = spawn, capabilities = {}, responseTimeoutMs = 5000 } = {}) {
  const piProvider = String(provider).trim() || 'minimax'
  const piModel = String(model).trim() || 'MiniMax-M2.7'
  const piEnvironment = { ...process.env }
  delete piEnvironment.OPENAI_API_KEY
  delete piEnvironment.OPENAI_API_KEY_DIR
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
  const resolveCwd = (target) => {
    const cwd = typeof cwdFor === 'function' ? cwdFor(target) : process.cwd()
    if (typeof cwd !== 'string' || cwd.length === 0) throw piError('PI_INVALID_CWD', 'Pi workspace cwd is required')
    return cwd
  }

  function createSession(bindingKey, target) {
    const child = spawnPiProcess(command, ['--mode', 'rpc', '--provider', piProvider, '--model', piModel], { cwd: resolveCwd(target), stdio: ['pipe', 'pipe', 'pipe'], env: piEnvironment }, spawnImpl)
    const session = {
      bindingKey,
      target,
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
      commandSequence: 0,
      liveText: '',
      finalText: null,
      error: null,
      stopRequested: false,
      closed: false,
      queueDepth: 0,
    }
    const append = (type, payload = {}) => {
      session.sequence += 1
      session.events.push({
        seq: session.sequence,
        type,
        payload: {
          ...payload,
          ...(session.currentRequestId ? { requestId: session.currentRequestId } : {}),
          ...(session.currentRunId ? { nativeRunId: session.currentRunId } : {}),
        },
      })
      if (session.events.length > 2000) session.events.shift()
    }
    const updateFinalText = (text) => {
      if (text) {
        session.liveText = text
        session.finalText = text
      }
    }
    const processLine = (line) => {
      let event
      try { event = JSON.parse(line) } catch { append('status', { message: 'Pi emitted malformed JSON.' }); return }
      if (!event || typeof event !== 'object' || Array.isArray(event)) { append('status', { message: 'Pi emitted an invalid JSON event.' }); return }
      const runtimeError = runtimeErrorFromEvent(event)
      if (runtimeError && !session.error) {
        session.error = runtimeError
        append('status', { nativeType: 'runtime_error', errorCode: runtimeError.code })
      }
      if (event.type === 'response') {
        const pending = findPendingResponse(session, event)
        if (!pending) {
          append('status', { nativeType: event.type, command: event.command, responseId: event.id ?? null, unmatched: true })
          return
        }
        clearPending(session, pending.id)
        if (event.success === false) pending.reject(commandError(event))
        else pending.resolve(event)
        return
      }
      if (event.type === 'message_update') {
        const update = event.assistantMessageEvent ?? {}
        if (update.type === 'text_delta') {
          session.liveText += update.delta ?? ''
          append('text_delta', { text: update.delta ?? '', nativeType: update.type })
        } else {
          append('status', { nativeType: update.type })
        }
      } else if (event.type === 'message_end') {
        updateFinalText(textFromMessage(event.message))
        append('status', { nativeType: event.type })
      } else if (event.type === 'turn_end') {
        updateFinalText(textFromMessage(event.message))
        append('status', { nativeType: event.type })
      } else if (event.type === 'tool_execution_start') {
        append('tool_started', { nativeBlockId: event.toolCallId, message: event.toolName })
      } else if (event.type === 'tool_execution_end') {
        append('tool_finished', { nativeBlockId: event.toolCallId, message: event.toolName })
      } else if (event.type === 'queue_update') {
        const queueDepth = Number.isInteger(event.pendingMessageCount)
          ? event.pendingMessageCount
          : Number.isInteger(event.data?.pendingMessageCount) ? event.data.pendingMessageCount
            : Array.isArray(event.queue) ? event.queue.length
              : Array.isArray(event.steering) || Array.isArray(event.followUp) ? (event.steering?.length ?? 0) + (event.followUp?.length ?? 0)
                : null
        if (queueDepth !== null) session.queueDepth = queueDepth
        append('status', { nativeType: event.type, ...(queueDepth === null ? {} : { queueDepth }) })
      } else if (event.type === 'agent_end') {
        updateFinalText(finalAssistantText(event.messages))
        append('status', { nativeType: event.type })
      } else if (event.type === 'agent_settled') {
        if (session.error) session.turnStatus = 'failed'
        else if (session.turnStatus === 'stopping' || session.stopRequested) session.turnStatus = 'interrupted'
        else if (session.turnStatus === 'running') session.turnStatus = 'completed'
        session.stopRequested = false
        session.queueDepth = 0
        append('status', { status: session.turnStatus, nativeType: event.type, ...(session.error ? { errorCode: session.error.code } : {}) })
      } else {
        append('status', { nativeType: event.type })
      }
    }
    const consume = (chunk) => {
      session.buffer += session.decoder.write(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
      let newlineIndex
      while ((newlineIndex = session.buffer.indexOf('\n')) !== -1) {
        let line = session.buffer.slice(0, newlineIndex)
        session.buffer = session.buffer.slice(newlineIndex + 1)
        if (line.endsWith('\r')) line = line.slice(0, -1)
        if (line.trim()) processLine(line)
      }
    }
    child.stdout.on('data', consume)
    child.on('error', (error) => {
      if (session.closed) return
      session.closed = true
      session.status = 'failed'
      rejectPending(session, piError('PI_PROCESS_ERROR', error.message))
      if (session.turnStatus === 'running' || session.turnStatus === 'stopping') session.turnStatus = 'failed'
      append('status', { status: session.turnStatus, message: error.message })
    })
    child.on('close', (code) => {
      if (session.closed) return
      const tail = session.decoder.end()
      session.buffer += tail
      if (session.buffer.endsWith('\r')) session.buffer = session.buffer.slice(0, -1)
      if (session.buffer.trim()) processLine(session.buffer)
      session.buffer = ''
      session.closed = true
      session.status = code === 0 ? 'stopped' : 'failed'
      rejectPending(session, piError('PI_PROCESS_EXITED', `Pi exited with code ${code ?? 'unknown'}.`))
      if (session.turnStatus === 'running' || session.turnStatus === 'stopping') {
        // Process exit is not the Pi lifecycle settlement signal. A stop ACK
        // or clean process exit alone cannot prove the requested turn settled.
        session.turnStatus = code === 0 ? 'unknown' : 'failed'
      }
      append('status', { status: session.turnStatus, exitCode: code })
    })
    sessions.set(bindingKey, session)
    return session
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
      sessionResume: false,
      models: false,
      reasoning: false,
      attachments: false,
    },
    async ensureSession({ bindingKey, target, recoverOnly = false }) {
      const existing = sessions.get(bindingKey)
      if (existing) {
        if (!existing.closed) return { bindingKey, status: 'ready', nativeSessionId: existing.nativeSessionId }
        return { bindingKey, status: 'unknown', nativeSessionId: null }
      }
      if (recoverOnly) return { bindingKey, status: 'unknown', nativeSessionId: null }
      const session = createSession(bindingKey, target)
      return { bindingKey, status: 'ready', nativeSessionId: session.nativeSessionId }
    },
    async startTurn({ requestId, bindingKey, nativeSessionId, target, message, handoff = null, attachments = [] }) {
      const session = sessions.get(bindingKey)
      if (!session) return { requestId, nativeSessionId: null, nativeRunId: null, status: 'unknown', lastEventSeq: 0 }
      if (session.closed || nativeSessionId !== session.nativeSessionId) return { requestId, nativeSessionId: nativeSessionId ?? null, nativeRunId: null, status: 'unknown', lastEventSeq: 0 }
      if (session.turnStatus === 'running' || session.turnStatus === 'stopping') throw piError('PI_BUSY', 'Pi already has an active turn')
      if (attachments.length > 0) throw piError('CAPABILITY_UNAVAILABLE', 'Pi attachments are unavailable')
      if (target.reasoningEffort) throw piError('CAPABILITY_UNAVAILABLE', 'Pi reasoning is unavailable')
      session.currentRequestId = requestId
      session.currentRunId = requestId
      session.turnStatus = 'running'
      session.stopRequested = false
      session.queueDepth = 0
      session.liveText = ''
      session.finalText = null
      session.error = null
      try {
        if (target.modelId) {
          const separator = target.modelId.indexOf(':')
          if (separator <= 0 || separator === target.modelId.length - 1) throw piError('INVALID_MODEL', 'Pi modelId must use the explicit provider:model form')
          const provider = target.modelId.slice(0, separator)
          const modelId = target.modelId.slice(separator + 1)
          await sendCommand(session, { type: 'set_model', provider, modelId }, `${requestId}:set_model`)
        }
        await sendCommand(session, { type: 'prompt', message: formatHandoffPrompt(message, handoff) }, requestId)
      } catch (error) {
        session.turnStatus = 'failed'
        throw error
      }
      return { requestId, nativeSessionId: session.nativeSessionId, nativeRunId: requestId, status: statusFor(session), lastEventSeq: 0 }
    },
    async interruptTurn({ requestId, bindingKey, nativeSessionId, nativeRunId }) {
      const session = sessions.get(bindingKey)
      if (!session || session.closed || session.nativeSessionId !== nativeSessionId || session.currentRunId !== nativeRunId) {
        return { requestId, accepted: false, turn: { requestId, nativeSessionId, nativeRunId, status: 'unknown', lastEventSeq: 0 } }
      }
      if (session.turnStatus !== 'running') return { requestId, accepted: false, turn: getTurn(session, session.currentRequestId ?? requestId) }
      session.stopRequested = true
      session.turnStatus = 'stopping'
      try {
        await sendCommand(session, { type: 'abort' }, `${requestId}:abort`)
      } catch {
        session.stopRequested = false
        session.turnStatus = 'running'
        return { requestId, accepted: false, turn: getTurn(session, session.currentRequestId ?? requestId) }
      }
      return { requestId, accepted: true, turn: getTurn(session, session.currentRequestId ?? requestId) }
    },
    async readEvents({ requestId, bindingKey, nativeSessionId, nativeRunId, afterSeq = 0 }) {
      const session = sessions.get(bindingKey)
      if (!session || nativeSessionId !== session.nativeSessionId || !nativeRunId || session.currentRunId !== nativeRunId) {
        return { events: [], turn: { requestId, nativeSessionId: nativeSessionId ?? null, nativeRunId: nativeRunId ?? null, status: 'unknown', lastEventSeq: 0 } }
      }
      const projection = eventProjectionFor(bindingKey, nativeRunId)
      const projected = projectEvents(projection, session.events, afterSeq, nativeRunId)
      return { events: projected.events, turn: getTurn(session, requestId, projection.nextSeq) }
    },
    async getTurn({ requestId, bindingKey, nativeSessionId, nativeRunId }) {
      const session = sessions.get(bindingKey)
      if (!session || nativeSessionId !== session.nativeSessionId || !nativeRunId || session.currentRunId !== nativeRunId) return { requestId, nativeSessionId: nativeSessionId ?? null, nativeRunId: nativeRunId ?? null, status: 'unknown', lastEventSeq: 0 }
      const projection = eventProjectionFor(bindingKey, nativeRunId)
      return getTurn(session, requestId, projection.nextSeq)
    },
    async listModels() { return { models: [], observedAt: new Date().toISOString() } },
    async getQuota() { return null },
    async getInputBudget() { return { nativeAvailableInputTokens: null, reservedOutputTokens: null, nativeCompactionSupported: false, admission: 'unverified', observedAt: new Date().toISOString() } },
  }
  return adapter

  function sendCommand(session, commandPayload, id) {
    const commandId = id ?? `${session.bindingKey}:command:${++session.commandSequence}`
    const value = { ...commandPayload, id: commandId }
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(commandId)
        reject(piError('PI_RESPONSE_TIMEOUT', `Pi did not respond to ${commandPayload.type}.`))
      }, responseTimeoutMs)
      timer.unref?.()
      session.pending.set(commandId, { id: commandId, command: commandPayload.type, resolve, reject, timer })
      try {
        if (session.child.stdin.destroyed === true) throw piError('PI_UNKNOWN', 'Pi stdin is closed')
        session.child.stdin.write(`${JSON.stringify(value)}\n`)
      } catch (error) {
        clearPending(session, commandId)
        reject(error)
      }
    })
    return promise
  }
}


function spawnPiProcess(command, args, options, spawnImpl) {
  if (process.platform !== 'win32') return spawnImpl(command, args, options)

  const commandName = path.win32.basename(command)
  const isWindowsCmdShim = /\.(cmd|bat)$/i.test(commandName)
  const isWindowsBarePathCommand = !/[\\/]/.test(command) && !/\.[^\\/.\s]+$/i.test(commandName)
  if (!isWindowsCmdShim && !isWindowsBarePathCommand) return spawnImpl(command, args, options)

  const commandLine = [command, ...args].map(quoteWindowsArgument).join(' ')
  return spawnImpl(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', commandLine],
    options,
  )
}

function quoteWindowsArgument(value) {
  const text = String(value)
  if (!/[\s"]/.test(text)) return text
  return `"${text.replaceAll(/(\\*)"/g, '$1$1\\"').replaceAll(/(\\+)$/g, '$1$1')}"`
}

function findPendingResponse(session, event) {
  if (event.id !== undefined && event.id !== null) return session.pending.get(event.id) ?? null
  const matches = Array.from(session.pending.values()).filter((pending) => pending.command === event.command)
  return matches.length === 1 ? matches[0] : null
}

function clearPending(session, id) {
  const pending = session.pending.get(id)
  if (!pending) return
  clearTimeout(pending.timer)
  session.pending.delete(id)
}

function rejectPending(session, error) {
  for (const pending of session.pending.values()) {
    clearTimeout(pending.timer)
    pending.reject(error)
  }
  session.pending.clear()
}

function statusFor(session) {
  return session.turnStatus === 'running'
    ? 'running'
    : session.turnStatus === 'stopping'
      ? 'stopping'
      : session.turnStatus === 'completed'
        ? 'completed'
        : session.turnStatus === 'interrupted'
          ? 'interrupted'
          : session.turnStatus === 'failed'
            ? 'failed'
            : 'unknown'
}

function getTurn(session, requestId, projectedCursor = 0) {
  return {
    requestId,
    nativeSessionId: session.nativeSessionId,
    nativeRunId: session.currentRunId,
    status: statusFor(session),
    lastEventSeq: projectedCursor,
    output: session.finalText ?? session.liveText,
    ...(session.error ? { error: { ...session.error } } : {}),
  }
}

export default createPiAdapter
