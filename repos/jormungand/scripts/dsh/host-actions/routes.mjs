import { readBody, sendJson } from '../routes.mjs'

/** Mount authenticated host actions below the v1 namespace. */
export function createHostActionHandler({ ethernet } = {}) {
  return async function hostActionHandler(request, response, url) {
    if (request.method === 'POST' && url.pathname === '/dsh/v1/host-actions/ethernet-restart') {
      if (!ethernet?.request) return false
      const body = await readBody(request)
      sendJson(response, 202, await ethernet.request(body))
      return true
    }
    const match = url.pathname.match(/^\/dsh\/v1\/host-actions\/by-request\/([^/]+)$/u)
    if (request.method === 'GET' && match) {
      if (!ethernet?.get) return false
      sendJson(response, 200, await ethernet.get({ requestId: decodeURIComponent(match[1]) }))
      return true
    }
    return false
  }
}

export default createHostActionHandler
