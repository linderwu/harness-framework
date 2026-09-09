const TERMINAL = new Set(['completed', 'failed', 'unknown', 'rejected'])

function actionError(code, message, httpStatus = 400) {
  const error = new Error(message)
  error.code = code
  error.httpStatus = httpStatus
  return error
}

function validateRequest(input = {}) {
  if (typeof input.requestId !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/u.test(input.requestId)) {
    throw actionError('INVALID_REQUEST_ID', 'requestId is required')
  }
  if (input.hostId !== 'A') throw actionError('UNKNOWN_HOST', 'ethernet repair is only registered for host A', 422)
  return { requestId: input.requestId, hostId: input.hostId }
}

function validateInventory(inventory) {
  if (!inventory || inventory.kind !== 'ethernet') throw actionError('ETHERNET_NOT_REGISTERED', 'registered Ethernet inventory is required', 422)
  if (typeof inventory.interfaceName !== 'string' || inventory.interfaceName.length === 0) throw actionError('ETHERNET_INTERFACE_UNKNOWN', 'Ethernet interface name is not registered', 422)
  if (typeof inventory.mac !== 'string' && !Number.isInteger(inventory.index)) throw actionError('ETHERNET_IDENTITY_UNKNOWN', 'Ethernet MAC or index is not registered', 422)
  if (inventory.internetRouteUsesTarget === true) throw actionError('ETHERNET_IS_DEFAULT_ROUTE', 'refusing to restart the interface carrying the default route', 409)
  return Object.freeze({ ...inventory })
}

function normalizeResult(result = {}) {
  const status = TERMINAL.has(result.status) ? result.status : 'unknown'
  return {
    status,
    ...(result.downAttempted !== undefined ? { downAttempted: result.downAttempted === true } : {}),
    ...(result.upAttempted !== undefined ? { upAttempted: result.upAttempted === true } : {}),
    ...(result.message ? { message: String(result.message).slice(0, 500) } : {}),
  }
}

/**
 * Build the host-local Ethernet repair operation.
 *
 * The caller supplies inspect/execute implementations owned by the service
 * account. Requests never carry shell text or an interface selector.
 */
export function createEthernetRepair({ store, inspect, execute, now = () => new Date().toISOString() } = {}) {
  if (!store || typeof store.reserve !== 'function' || typeof store.patch !== 'function' || typeof store.read !== 'function') throw new Error('store is required')
  if (typeof inspect !== 'function' || typeof execute !== 'function') throw new Error('inspect and execute are required')

  async function request(input = {}) {
    const request = validateRequest(input)
    const payloadHash = JSON.stringify({ kind: 'ethernet-restart', hostId: request.hostId })
    const reserved = await store.transact(() => store.reserve('host-action', request.requestId, {
      kind: 'ethernet-restart',
      hostId: request.hostId,
      status: 'prepared',
      payloadHash,
      createdAt: now(),
    }))
    if (!reserved.created) return reserved.record

    let inventory
    try {
      inventory = validateInventory(await inspect({ hostId: request.hostId }))
    } catch (error) {
      return store.patch('host-action', request.requestId, { status: error.code === 'ETHERNET_IS_DEFAULT_ROUTE' ? 'rejected' : 'unknown', error: error.code ?? 'INVENTORY_UNKNOWN' })
    }
    await store.patch('host-action', request.requestId, { status: 'submitted', inventory: { interfaceName: inventory.interfaceName, ...(inventory.mac ? { mac: inventory.mac } : { index: inventory.index }) } })
    try {
      const result = normalizeResult(await execute({ hostId: request.hostId, inventory }))
      return store.patch('host-action', request.requestId, { ...result, finishedAt: now() })
    } catch (error) {
      return store.patch('host-action', request.requestId, { status: 'unknown', error: error.code ?? 'EXECUTION_UNKNOWN', finishedAt: now() })
    }
  }

  async function get({ requestId } = {}) {
    if (typeof requestId !== 'string' || !requestId) throw actionError('INVALID_REQUEST_ID', 'requestId is required')
    const record = await store.read('operations/host-action', requestId)
    if (!record) throw actionError('RECEIPT_NOT_FOUND', 'host action receipt not found', 404)
    return record
  }

  return { request, get, validateInventory }
}

export { validateInventory }
