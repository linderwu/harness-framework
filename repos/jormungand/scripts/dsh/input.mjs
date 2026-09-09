const MAX_REQUEST_BYTES = 1024 * 1024

function inputError(code, message, httpStatus = 400) {
  const error = new Error(message)
  error.code = code
  error.httpStatus = httpStatus
  return error
}

export function encodeInput(value, maxBytes = MAX_REQUEST_BYTES) {
  let body
  try {
    body = JSON.stringify(value)
  } catch {
    throw inputError('INVALID_INPUT', 'request body is not serializable')
  }
  if (Buffer.byteLength(body, 'utf8') > maxBytes) {
    throw inputError('INPUT_TOO_LARGE', 'request body exceeds the bridge limit', 413)
  }
  return body
}

export function validateHandoff(handoff) {
  if (handoff === null || handoff === undefined) return null
  if (!handoff || typeof handoff !== 'object' || handoff.version !== 1) {
    throw inputError('INVALID_HANDOFF', 'handoff version must be 1')
  }
  if (!handoff.origin || typeof handoff.origin.conversationId !== 'string' || typeof handoff.origin.revision !== 'string') {
    throw inputError('INVALID_HANDOFF', 'handoff origin is required')
  }
  if (!Array.isArray(handoff.messages) || !Array.isArray(handoff.summaries)) {
    throw inputError('INVALID_HANDOFF', 'handoff messages and summaries are required')
  }
  return handoff
}

export function validateTarget(target) {
  if (!target || typeof target !== 'object') throw inputError('INVALID_TARGET', 'target is required')
  for (const field of ['agentId', 'hostId', 'workspaceId']) {
    if (typeof target[field] !== 'string' || target[field].length === 0 || target[field].length > 200) {
      throw inputError('INVALID_TARGET', `${field} is required`)
    }
  }
  return {
    agentId: target.agentId,
    hostId: target.hostId,
    workspaceId: target.workspaceId,
    ...(typeof target.modelId === 'string' ? { modelId: target.modelId } : {}),
    ...(typeof target.reasoningEffort === 'string' ? { reasoningEffort: target.reasoningEffort } : {}),
  }
}

export { MAX_REQUEST_BYTES }
