import assert from "node:assert/strict"
import test from "node:test"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

type RequestRecord = { method: string; params: Record<string, unknown> }

function createRecordingTransport() {
  const requests: RequestRecord[] = []
  const responses: Record<string, unknown> = {
    initialize: {},
    "thread/start": { thread: { id: "thread-new" } },
    "thread/resume": { thread: { id: "thread-existing" } },
    "thread/name/set": {}
  }

  return {
    requests,
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params })
      return responses[method]
    }
  }
}

function createThreadReadFallbackTransport() {
  const requests: RequestRecord[] = []
  return {
    requests,
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params })
      if (method === "initialize") return {}
      if (method === "thread/start") return { thread: { id: "thread-read" } }
      if (method === "thread/read") throw new Error("thread not loaded: thread-read")
      if (method === "thread/turns/list") {
        return { data: [{ id: "turn-1", status: "completed", items: [] }] }
      }
      return {}
    }
  }
}

function createEmptyThreadTransport() {
  const requests: RequestRecord[] = []
  return {
    requests,
    async request(method: string, params: Record<string, unknown>) {
      requests.push({ method, params })
      if (method === "initialize") return {}
      if (method === "thread/start") return { thread: { id: "thread-empty" } }
      if (method === "thread/read") {
        throw new Error("thread thread-empty is not materialized yet; includeTurns is unavailable before first user message")
      }
      return {}
    }
  }
}

async function loadSessionModule() {
  const dynamicImport = new Function(
    "modulePath",
    "return import(modulePath)"
  ) as (modulePath: string) => Promise<unknown>
  return await dynamicImport(
    pathToFileURL(resolve("scripts/codex-app-server-session.mjs")).href
  ) as {
    createCodexAppServerSession: (input: {
      request: (method: string, params: Record<string, unknown>) => Promise<unknown>
      notify?: (method: string, params: Record<string, unknown>) => void
      workspacePath: string
      permissionMode: "full" | "restricted"
      threadId?: string
      name?: string
    }) => {
      start: () => Promise<{ threadId: string }>
      readThread: () => Promise<unknown>
      unarchive: () => Promise<void>
    }
  }
}

test("resumes a persisted thread instead of starting a replacement", async () => {
  const sessionModule = await loadSessionModule()
  const transport = createRecordingTransport()
  const session = sessionModule.createCodexAppServerSession({
    request: transport.request,
    notify: (method, params) => transport.requests.push({ method, params }),
    workspacePath: "C:/workspace",
    permissionMode: "full",
    threadId: "thread-existing",
    name: "Harness · Existing"
  })

  const result = await session.start()

  assert.equal(result.threadId, "thread-existing")
  assert.equal(transport.requests.some((request) => request.method === "thread/resume"), true)
  assert.equal(transport.requests.some((request) => request.method === "thread/start"), false)
})

test("full mode applies danger full access without administrator elevation", async () => {
  const sessionModule = await loadSessionModule()
  const transport = createRecordingTransport()
  const session = sessionModule.createCodexAppServerSession({
    request: transport.request,
    notify: (method, params) => transport.requests.push({ method, params }),
    workspacePath: "C:/workspace",
    permissionMode: "full",
    name: "Harness · New"
  })

  await session.start()

  const startRequest = transport.requests.find((request) => request.method === "thread/start")
  assert.deepEqual(startRequest?.params, {
    cwd: "C:/workspace",
    sandbox: "danger-full-access",
    approvalPolicy: "never",
    threadSource: "jormungand"
  })
  assert.deepEqual(
    transport.requests.find((request) => request.method === "thread/name/set")?.params,
    { threadId: "thread-new", name: "Harness · New" }
  )
})

test("unarchives a native thread through the App Server", async () => {
  const sessionModule = await loadSessionModule()
  const transport = createRecordingTransport()
  const session = sessionModule.createCodexAppServerSession({
    request: transport.request,
    notify: (method, params) => transport.requests.push({ method, params }),
    workspacePath: "C:/workspace",
    permissionMode: "full",
    threadId: "thread-archived"
  })

  await session.start()
  await session.unarchive()

  assert.equal(
    transport.requests.some((request) => request.method === "thread/unarchive"),
    true
  )
})

test("falls back to experimental turn listing when thread/read reports not loaded", async () => {
  const sessionModule = await loadSessionModule()
  const transport = createThreadReadFallbackTransport()
  const session = sessionModule.createCodexAppServerSession({
    request: transport.request,
    notify: (method, params) => transport.requests.push({ method, params }),
    workspacePath: "C:/workspace",
    permissionMode: "full"
  })

  await session.start()
  const result = await session.readThread()

  assert.deepEqual(result, {
    thread: {
      id: "thread-read",
      turns: [{ id: "turn-1", status: "completed", items: [] }]
    }
  })
  assert.equal(transport.requests.at(-1)?.method, "thread/turns/list")
})

test("returns an empty thread before the first native user message", async () => {
  const sessionModule = await loadSessionModule()
  const transport = createEmptyThreadTransport()
  const session = sessionModule.createCodexAppServerSession({
    request: transport.request,
    notify: (method, params) => transport.requests.push({ method, params }),
    workspacePath: "C:/workspace",
    permissionMode: "full"
  })

  await session.start()

  assert.deepEqual(await session.readThread(), {
    thread: { id: "thread-empty", turns: [] }
  })
})
