import { openStore } from './store.mjs'
import { createDshService } from './service.mjs'
import { createDshV1Handler } from './routes.mjs'

/**
 * Assemble the durable v1 HTTP surface without changing the legacy bridge
 * protocol. Callers own the runtime adapter registry and the store lifecycle.
 */
export async function createDshBridgeV1({ hostId, registry, storeRoot, token }) {
  if (typeof token !== 'string' || token.length < 16) {
    const error = new Error('DSH v1 bridge token is required')
    error.code = 'BRIDGE_TOKEN_REQUIRED'
    throw error
  }
  const store = await openStore(storeRoot)
  const service = createDshService({ registry, store })
  const authenticate = async (request) => request.headers.authorization === `Bearer ${token}`
  const handler = createDshV1Handler({ service, authenticate })
  return { handler, service, store, close: () => store.close(), hostId }
}

export default createDshBridgeV1
