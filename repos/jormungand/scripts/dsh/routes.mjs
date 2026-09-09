import { encodeInput, MAX_REQUEST_BYTES, validateTarget } from './input.mjs'

function routeError(code, message, httpStatus = 400, retryable = false, requestId) {
  const error = new Error(message)
  error.code = code
  error.httpStatus = httpStatus
  error.retryable = retryable
  error.requestId = requestId
  return error
}

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

async function readBody(request) {
  const chunks = []
  let bytes = 0
  for await (const chunk of request) {
    bytes += chunk.length
    if (bytes > MAX_REQUEST_BYTES) throw routeError('INPUT_TOO_LARGE', 'request body exceeds the bridge limit', 413)
    chunks.push(chunk)
  }
  if (bytes === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(encodeInput(JSON.parse(raw))) } catch (error) {
    if (error.code) throw error
    throw routeError('INVALID_JSON', 'request body must be valid JSON')
  }
}

function normalizedError(error, requestId) {
  return { error: { code: error.code ?? 'INTERNAL_ERROR', message: error.message ?? 'request failed', retryable: error.retryable === true, ...(requestId ? { requestId } : {}) } }
}

export function createDshV1Handler({ service, authenticate, hostHandlers } = {}) {
  if (!service) throw new Error('service is required')
  return async function dshV1Handler(request, response, url = new URL(request.url ?? '/', 'http://127.0.0.1')) {
    if (!url.pathname.startsWith('/dsh/v1/')) return false
    try {
      if (typeof authenticate === 'function' && !(await authenticate(request))) {
        sendJson(response, 401, normalizedError(routeError('UNAUTHORIZED', 'authentication required', 401)))
        return true
      }
      if (hostHandlers && await hostHandlers(request, response, url)) return true
      if (request.method === 'GET' && url.pathname === '/dsh/v1/capabilities') {
        sendJson(response, 200, await service.getCapabilities()); return true
      }
      const modelMatch = url.pathname.match(/^\/dsh\/v1\/models$/u)
      if (request.method === 'GET' && modelMatch) {
        sendJson(response, 200, await service.listModels({ agentId: url.searchParams.get('agentId'), hostId: url.searchParams.get('hostId') })); return true
      }
      if (request.method === 'GET' && url.pathname === '/dsh/v1/quota') {
        sendJson(response, 200, await service.getQuota({ agentId: url.searchParams.get('agentId'), hostId: url.searchParams.get('hostId') })); return true
      }
      if (request.method === 'GET' && url.pathname === '/dsh/v1/input-budget') {
        const target = validateTarget({ agentId: url.searchParams.get('agentId'), hostId: url.searchParams.get('hostId'), workspaceId: url.searchParams.get('workspaceId'), modelId: url.searchParams.get('modelId') ?? undefined, reasoningEffort: url.searchParams.get('reasoningEffort') ?? undefined })
        sendJson(response, 200, await service.getInputBudget({ bindingKey: url.searchParams.get('bindingKey'), target })); return true
      }
      if (request.method === 'POST' && url.pathname === '/dsh/v1/sessions') {
        const body = await readBody(request)
        const target = validateTarget(body.target)
        const result = await service.ensureSession({ bindingKey: body.bindingKey, requestId: body.requestId, target, recoverOnly: false })
        sendJson(response, result?.status === 'ready' ? 201 : 202, result); return true
      }
      const bindingMatch = url.pathname.match(/^\/dsh\/v1\/sessions\/by-binding\/([^/]+)$/u)
      if (request.method === 'GET' && bindingMatch) {
        const key = decodeURIComponent(bindingMatch[1])
        const result = typeof service.recoverSession === 'function'
          ? await service.recoverSession({ bindingKey: key })
          : await service.ensureSession({ bindingKey: key, requestId: url.searchParams.get('requestId') ?? `recover-${key}`, target: validateTarget({ agentId: url.searchParams.get('agentId'), hostId: url.searchParams.get('hostId'), workspaceId: url.searchParams.get('workspaceId') }), recoverOnly: true })
        sendJson(response, 200, result); return true
      }
      if (request.method === 'POST' && url.pathname === '/dsh/v1/turns') {
        const body = await readBody(request)
        const result = await service.startTurn({ ...body, target: validateTarget(body.target) })
        sendJson(response, 202, result); return true
      }
      const turnMatch = url.pathname.match(/^\/dsh\/v1\/turns\/([^/]+)$/u)
      const turnEventsMatch = url.pathname.match(/^\/dsh\/v1\/turns\/([^/]+)\/events$/u)
      const turnInterruptMatch = url.pathname.match(/^\/dsh\/v1\/turns\/([^/]+)\/interrupt$/u)
      const requestMatch = url.pathname.match(/^\/dsh\/v1\/turns\/by-request\/([^/]+)$/u)
      if (request.method === 'GET' && requestMatch) { sendJson(response, 200, await service.getTurn({ requestId: decodeURIComponent(requestMatch[1]) })); return true }
      if (request.method === 'GET' && turnEventsMatch) { sendJson(response, 200, await service.readEvents({ requestId: decodeURIComponent(turnEventsMatch[1]), afterSeq: Number(url.searchParams.get('afterSeq') ?? 0) })); return true }
      if (request.method === 'POST' && turnInterruptMatch) {
        const body = await readBody(request)
        sendJson(response, 202, await service.interruptTurn({ requestId: decodeURIComponent(turnInterruptMatch[1]), ...body })); return true
      }
      if (request.method === 'GET' && turnMatch) { sendJson(response, 200, await service.getTurn({ requestId: decodeURIComponent(turnMatch[1]) })); return true }
      throw routeError('NOT_FOUND', 'not found', 404)
    } catch (error) {
      sendJson(response, error.httpStatus ?? 500, normalizedError(error))
      return true
    }
  }
}

export { readBody, normalizedError }
