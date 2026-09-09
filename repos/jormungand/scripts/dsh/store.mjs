import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join, resolve } from 'node:path'

const COLLECTIONS = new Set(['bindings', 'operations/session', 'operations/turn', 'events'])
const KEY_PATTERN = /^[a-zA-Z0-9_-]{1,200}$/u

function storeError(code, message) {
  const error = new Error(message)
  error.code = code
  return error
}

function assertKey(value) {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) throw storeError('INVALID_KEY', 'invalid store key')
}

function assertCollection(value) {
  if (!COLLECTIONS.has(value)) throw storeError('INVALID_COLLECTION', 'invalid store collection')
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export async function writeAtomic(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(JSON.stringify(value), 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  try {
    await rename(temporary, file)
  } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw storeError('STORE_CORRUPT', `invalid store record: ${file}`)
  }
}

export async function openStore(rootDirectory) {
  const root = resolve(rootDirectory)
  await mkdir(root, { recursive: true })
  for (const collection of COLLECTIONS) await mkdir(join(root, collection), { recursive: true })
  const lockPath = join(root, 'writer.lock')
  let lockHandle
  try {
    lockHandle = await open(lockPath, 'wx', 0o600)
    await lockHandle.writeFile(JSON.stringify({ pid: process.pid, bootId: randomUUID() }))
    await lockHandle.sync()
  } catch (error) {
    await lockHandle?.close().catch(() => undefined)
    if (error.code === 'EEXIST') throw storeError('WRITER_OWNERSHIP_UNKNOWN', 'store writer already exists')
    throw error
  }

  let closed = false
  let queue = Promise.resolve()
  const pathFor = (collection, key) => {
    assertCollection(collection)
    assertKey(key)
    return join(root, collection, `${key}.json`)
  }
  const read = async (collection, key) => readJson(pathFor(collection, key))
  const putBinding = async (key, value) => writeAtomic(pathFor('bindings', key), structuredClone(value))
  const reserve = async (operation, key, value) => {
    const collection = `operations/${operation}`
    const result = await read(collection, key)
    const payloadHash = value?.payloadHash ?? digest(value)
    if (result) {
      if (result.payloadHash !== payloadHash) throw storeError('IDEMPOTENCY_CONFLICT', 'request id was reused with different content')
      return { created: false, record: structuredClone(result) }
    }
    const record = { ...structuredClone(value), payloadHash, key, createdAt: new Date().toISOString() }
    await writeAtomic(pathFor(collection, key), record)
    return { created: true, record: structuredClone(record) }
  }
  const patch = (operation, key, changes) => transact(async () => {
    const collection = `operations/${operation}`
    const current = await read(collection, key)
    if (!current) throw storeError('RECORD_NOT_FOUND', 'operation record not found')
    const next = { ...current, ...structuredClone(changes), updatedAt: new Date().toISOString() }
    await writeAtomic(pathFor(collection, key), next)
    return structuredClone(next)
  })
  const append = (requestId, event) => transact(async () => {
    assertKey(requestId)
    const file = pathFor('events', requestId)
    const current = (await read('events', requestId)) ?? { requestId, events: [] }
    const events = current.events
    const existing = events.find(item => item.seq === event.seq)
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(event)) throw storeError('EVENT_SEQUENCE_CONFLICT', 'event sequence conflict')
      return structuredClone(current)
    }
    const lastSeq = events.at(-1)?.seq ?? 0
    if (event.seq !== lastSeq + 1) throw storeError('EVENT_SEQUENCE_CONFLICT', 'event sequence is not contiguous')
    const nextEvents = [...events, structuredClone(event)]
    while (nextEvents.length > 200 || Buffer.byteLength(JSON.stringify(nextEvents), 'utf8') > 256 * 1024) nextEvents.shift()
    const next = { requestId, events: nextEvents }
    await writeAtomic(file, next)
    return structuredClone(next)
  })
  const readEvents = async (requestId, afterSeq = 0) => {
    const current = await read('events', requestId)
    const events = current?.events ?? []
    const firstSeq = events[0]?.seq ?? null
    const visible = events.filter(item => item.seq > afterSeq)
    const continuity = firstSeq !== null && afterSeq < firstSeq - 1 ? 'gap' : 'ok'
    return { events: visible, nextSeq: visible.at(-1)?.seq ?? afterSeq, hasMore: continuity === 'gap' || visible.length >= 200, continuity }
  }
  const transact = operation => {
    const job = queue.then(async () => {
      if (closed) throw storeError('STORE_CLOSED', 'store is closed')
      return operation()
    })
    queue = job.catch(() => undefined)
    return job
  }
  const close = async () => {
    if (closed) return
    closed = true
    await queue
    await lockHandle.close()
    await unlink(lockPath).catch(() => undefined)
  }
  return { root, read, putBinding, reserve, patch, append, readEvents, transact, close }
}
