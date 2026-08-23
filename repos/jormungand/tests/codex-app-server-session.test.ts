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
