import type {} from "../app/.well-known/agent-card.json/route"
import type {} from "../app/api/a2a/route"
import type {} from "../app/api/a2a/tasks/[id]/route"
import type {} from "../app/api/a2a/audit/[id]/route"

import assert from "node:assert/strict"
import { lstat, mkdir, realpath, symlink } from "node:fs/promises"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { TestContext } from "node:test"

import type { AgentArtifactResult } from "../lib/workflow"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import { sha256Json } from "../lib/a2a-runtime"
import { createWorkflowRun } from "../lib/workflow"

type A2ARouteDependencies = {
  repository: ReturnType<typeof createHiveMemoryRepository>
  getRun?: (id: string) => Promise<unknown>
  invokeAgent?: (input: Record<string, unknown>) => Promise<AgentArtifactResult>
  cancelAgentRun?: (run: unknown) => Promise<void> | void
  dispatchA2A?: (input: Record<string, unknown>) => Promise<unknown>
}

type AgentCardRouteModule = {
  GET: (request: Request) => Promise<Response>
  createAgentCardRouteHandlers?: (dependencies?: Record<string, never>) => {
    GET: (request: Request) => Promise<Response>
  }
}

type A2ARouteModule = {
  POST: (request: Request) => Promise<Response>
  createA2ARouteHandlers?: (dependencies: A2ARouteDependencies) => {
    POST: (request: Request) => Promise<Response>
  }
}

type A2ATaskRouteModule = {
  GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>
  POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>
  createA2ATaskRouteHandlers?: (dependencies: A2ARouteDependencies) => {
    GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>
    POST: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>
  }
}

type A2AAuditRouteModule = {
  GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>
  createA2AAuditRouteHandlers?: (dependencies: A2ARouteDependencies) => {
    GET: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>
  }
}

function createSendRequest(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: "rpc-route-1",
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: "message-route-1",
        contextId: "context-route-1",
        parts: [
          {
            kind: "text",
            text: "Summarize the current task."
          }
        ],
        metadata: {
          idempotencyKey: "route-idempotency-1",
          fromAgent: "external.user",
          toAgent: "codex"
        }
      }
    },
    ...overrides
  }
}

function createTaskContext(overrides: Record<string, unknown> = {}) {
  return {
    workflowRunId: "run-a2a-existing-1",
    executor: "openclaw.gengar",
    title: "Bound workflow task",
    fallbackBody: "fallback body",
    ...overrides
  }
}

async function createRepository(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-a2a-route-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)

  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  return { repository }
}

function openRepositoryAt(dataDir: string) {
  const database = openHiveDatabase({ dataDir })
  return {
    database,
    repository: createHiveMemoryRepository(database)
  }
}

async function createRestartableRepository(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-a2a-route-"))
  let current = openRepositoryAt(dataDir)
  let closed = false

  const closeCurrent = () => {
    if (closed) {
      return
    }
    current.database.close()
    closed = true
  }

  t.after(async () => {
    closeCurrent()
    await rm(dataDir, { recursive: true, force: true })
  })

  return {
    get repository() {
      return current.repository
    },
    restart() {
      closeCurrent()
      current = openRepositoryAt(dataDir)
      closed = false
      return current.repository
    }
  }
}

async function ensureCompiledAlias() {
  const tmpRoot = join(process.cwd(), ".tmp-tests")
  const scopedRoot = join(tmpRoot, "node_modules", "@")
  const libLink = join(scopedRoot, "lib")
  const expectedTarget = join(tmpRoot, "lib")

  await mkdir(scopedRoot, { recursive: true })
  const existingLink = await lstat(libLink).catch(() => undefined)
  const existingTarget = existingLink?.isSymbolicLink()
    ? await realpath(libLink).catch(() => undefined)
    : undefined
  const expectedRealTarget = await realpath(expectedTarget).catch(() => undefined)
  if (existingTarget && expectedRealTarget && existingTarget === expectedRealTarget) {
    return
  }
  if (existingLink) {
    await rm(libLink, { recursive: true, force: true })
  }
  await symlink(expectedTarget, libLink, "junction").catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  })
}

async function importAgentCardRoute() {
  await ensureCompiledAlias()
  const modulePath = "../app/.well-known/agent-card.json/route"
  return await import(modulePath) as AgentCardRouteModule
}

async function importA2ARoute() {
  await ensureCompiledAlias()
  const modulePath = "../app/api/a2a/route"
  return await import(modulePath) as A2ARouteModule
}

async function importA2ATaskRoute() {
  await ensureCompiledAlias()
  const modulePath = "../app/api/a2a/tasks/[id]/route"
  return await import(modulePath) as A2ATaskRouteModule
}

async function importA2AAuditRoute() {
  await ensureCompiledAlias()
  const modulePath = "../app/api/a2a/audit/[id]/route"
  return await import(modulePath) as A2AAuditRouteModule
}

function restoreEnv(t: TestContext, key: string) {
  const previousValue = process.env[key]
  t.after(() => {
    if (previousValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previousValue
    }
  })
}

async function readJson(response: Response) {
  return await response.json() as Record<string, unknown>
}

function createExistingRun() {
  return createWorkflowRun({
    projectId: "project-a2a-1",
    projectName: "A2A Project",
    repository: "github.com/acme/a2a",
    requirement: "Handle one bounded A2A request",
    selectedAgent: "openclaw.gengar"
  })
}

test("Agent Card route declares protocolVersion 0.3, JSON-RPC endpoint, auth requirements, and supported target agents", async () => {
  const routeModule = await importAgentCardRoute()
  const handlers = routeModule.createAgentCardRouteHandlers?.() ?? routeModule
  const response = await handlers.GET(
    new Request("https://jormungand.test/.well-known/agent-card.json")
  )
  const body = await readJson(response)

  assert.equal(response.status, 200)
  assert.equal(body.protocolVersion, "0.3")
  assert.equal(body.jsonrpcEndpoint, "https://jormungand.test/api/a2a")
  assert.ok(Array.isArray(body.skills))
  assert.ok(Array.isArray(body.supportedTargetAgents))
  assert.deepEqual(body.capabilities, {
    methods: ["message/send", "message/stream"],
    taskGet: true,
    taskCancel: true,
    streaming: "sse"
  })
  assert.deepEqual(body.authentication, {
    required: true,
    type: "bearer-or-site-auth",
    header: "Authorization"
  })
})

test("A2A routes require a matching bearer token when JORMUNGAND_A2A_TOKEN is set and ignore query-string tokens", async (t) => {
  restoreEnv(t, "JORMUNGAND_A2A_TOKEN")
  process.env.JORMUNGAND_A2A_TOKEN = "top-secret-a2a-token"

  const { repository } = await createRepository(t)
  const rpcModule = await importA2ARoute()
  const taskModule = await importA2ATaskRoute()
  const auditModule = await importA2AAuditRoute()
  const rpcHandlers = rpcModule.createA2ARouteHandlers?.({ repository }) ?? rpcModule
  const taskHandlers = taskModule.createA2ATaskRouteHandlers?.({ repository }) ?? taskModule
  const auditHandlers = auditModule.createA2AAuditRouteHandlers?.({ repository }) ?? auditModule

  const rpcResponse = await rpcHandlers.POST(
    new Request("https://jormungand.test/api/a2a?token=top-secret-a2a-token", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createSendRequest())
    })
  )
  const rpcBody = await readJson(rpcResponse)

  assert.equal(rpcResponse.status, 401)
  assert.deepEqual(rpcBody, {
    jsonrpc: "2.0",
    error: {
      code: -32001,
      message: "Authentication required"
    },
    id: null
  })
  assert.doesNotMatch(JSON.stringify(rpcBody), /top-secret-a2a-token/)

  const taskResponse = await taskHandlers.GET(
    new Request("https://jormungand.test/api/a2a/tasks/task-123", {
      headers: { Authorization: "Bearer wrong-token" }
    }),
    { params: Promise.resolve({ id: "task-123" }) }
  )
  const taskBody = await readJson(taskResponse)
  assert.equal(taskResponse.status, 401)
  assert.equal(taskBody.error, "Authentication required.")
  assert.doesNotMatch(JSON.stringify(taskBody), /wrong-token|top-secret-a2a-token/)

  const auditResponse = await auditHandlers.GET(
    new Request("https://jormungand.test/api/a2a/audit/task-123"),
    { params: Promise.resolve({ id: "task-123" }) }
  )
  const auditBody = await readJson(auditResponse)
  assert.equal(auditResponse.status, 401)
  assert.equal(auditBody.error, "Authentication required.")
})

test("A2A JSON-RPC send route binds a valid workflowRunId and executor from the data part through injected dispatch", async (t) => {
  const { repository } = await createRepository(t)
  const run = createExistingRun()
  const captured: Array<Record<string, unknown>> = []
  const rpcRouteModule = await importA2ARoute()
  const handlers = rpcRouteModule.createA2ARouteHandlers?.({
    repository,
    getRun: async (id) => (id === run.id ? run : undefined),
    invokeAgent: async (input) => {
      captured.push(input)
      return {
        status: "completed",
        source: "simulated",
        body: "Injected dispatch finished."
      }
    }
  }) ?? rpcRouteModule

  const request = createSendRequest({
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: "message-route-bound-1",
        contextId: "context-route-bound-1",
        parts: [
          {
            kind: "data",
            data: createTaskContext({
              workflowRunId: run.id
            })
          }
        ],
        metadata: {
          idempotencyKey: "route-bound-idempotency-1",
          fromAgent: "external.user",
          toAgent: "openclaw:gengar"
        }
      }
    }
  })

  const response = await handlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    })
  )
  const body = await readJson(response)

  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i)
  assert.equal((body.result as { id?: string }).id !== undefined, true)
  assert.equal((body.result as { contextId?: string }).contextId, "context-route-bound-1")
  assert.equal(captured.length, 1)
  assert.equal(captured[0]?.run, run)
  assert.equal(captured[0]?.executor, "openclaw.gengar")
})

test("A2A JSON-RPC route returns stable JSON-RPC errors for malformed requests", async (t) => {
  const { repository } = await createRepository(t)
  const rpcRouteModule = await importA2ARoute()
  const handlers = rpcRouteModule.createA2ARouteHandlers?.({ repository }) ?? rpcRouteModule

  const response = await handlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{\"jsonrpc\":"
    })
  )
  const body = await readJson(response)

  assert.equal(response.status, 400)
  assert.deepEqual(body, {
    jsonrpc: "2.0",
    error: {
      code: -32700,
      message: "Malformed JSON body"
    },
    id: null
  })
})

test("A2A message/stream startup validation errors return JSON-RPC 4xx before committing SSE", async (t) => {
  const { repository } = await createRepository(t)
  const rpcRouteModule = await importA2ARoute()
  const handlers = rpcRouteModule.createA2ARouteHandlers?.({ repository }) ?? rpcRouteModule

  const malformedResponse = await handlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{\"jsonrpc\":"
    })
  )
  const malformedBody = await readJson(malformedResponse)
  assert.equal(malformedResponse.status, 400)
  assert.doesNotMatch(malformedResponse.headers.get("content-type") ?? "", /text\/event-stream/i)
  assert.deepEqual(malformedBody, {
    jsonrpc: "2.0",
    error: {
      code: -32700,
      message: "Malformed JSON body"
    },
    id: null
  })

  const invalidTargetResponse = await handlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        createSendRequest({
          id: "rpc-stream-invalid-target",
          method: "message/stream",
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-stream-invalid-target",
              contextId: "context-stream-invalid-target",
              parts: [{ kind: "text", text: "fail fast" }],
              metadata: {
                idempotencyKey: "stream-invalid-target-1",
                fromAgent: "external.user",
                toAgent: "forbidden-agent"
              }
            }
          }
        })
      )
    })
  )
  const invalidTargetBody = await readJson(invalidTargetResponse)
  assert.equal(invalidTargetResponse.status, 403)
  assert.doesNotMatch(invalidTargetResponse.headers.get("content-type") ?? "", /text\/event-stream/i)
  assert.deepEqual(invalidTargetBody, {
    jsonrpc: "2.0",
    error: {
      code: -32003,
      message: "Target agent is not allowed"
    },
    id: "rpc-stream-invalid-target"
  })

  const missingIdempotencyResponse = await handlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "rpc-stream-missing-idempotency",
        method: "message/stream",
        params: {
          message: {
            kind: "message",
            role: "user",
            messageId: "message-stream-missing-idempotency",
            contextId: "context-stream-missing-idempotency",
            parts: [{ kind: "text", text: "missing key" }],
            metadata: {
              fromAgent: "external.user",
              toAgent: "codex"
            }
          }
        }
      })
    })
  )
  const missingIdempotencyBody = await readJson(missingIdempotencyResponse)
  assert.equal(missingIdempotencyResponse.status, 400)
  assert.doesNotMatch(missingIdempotencyResponse.headers.get("content-type") ?? "", /text\/event-stream/i)
  assert.deepEqual(missingIdempotencyBody, {
    jsonrpc: "2.0",
    error: {
      code: -32602,
      message: "idempotencyKey is required"
    },
    id: "rpc-stream-missing-idempotency"
  })
})

test("A2A message/stream returns text/event-stream and emits ordered lifecycle, artifact, and terminal frames", async (t) => {
  const { repository } = await createRepository(t)
  const rpcRouteModule = await importA2ARoute()
  const handlers = rpcRouteModule.createA2ARouteHandlers?.({
    repository,
    dispatchA2A: async () => ({
      status: "completed",
      text: "Authorization: Bearer downstream-secret",
      artifacts: [
        {
          artifactId: "artifact-stream-route-1",
          text: "token=abc123"
        }
      ]
    })
  }) ?? rpcRouteModule

  const response = await handlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        createSendRequest({
          id: "rpc-stream-route-1",
          method: "message/stream",
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-stream-route-1",
              contextId: "context-stream-route-1",
              parts: [{ kind: "text", text: "stream the answer" }],
              metadata: {
                idempotencyKey: "stream-route-idempotency-1",
                fromAgent: "external.user",
                toAgent: "codex"
              }
            }
          }
        })
      )
    })
  )
  const body = await response.text()

  assert.equal(response.status, 200)
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/i)
  assert.match(body, /event: message_queued/)
  assert.match(body, /event: message_accepted/)
  assert.match(body, /event: task_working/)
  assert.match(body, /event: task_artifact_updated/)
  assert.match(body, /event: task_completed/)
  assert.ok(body.indexOf("message_queued") < body.indexOf("task_completed"))
  assert.doesNotMatch(body, /downstream-secret|abc123/)
})

test("A2A bound existing workflowRunId rejects waiting_for_approval before invokeAgent", async (t) => {
  const { repository } = await createRepository(t)
  const run = {
    ...createExistingRun(),
    status: "waiting_for_approval" as const
  }
  let invokeCalls = 0
  const rpcRouteModule = await importA2ARoute()
  const handlers = rpcRouteModule.createA2ARouteHandlers?.({
    repository,
    getRun: async (id) => (id === run.id ? run : undefined),
    invokeAgent: async () => {
      invokeCalls += 1
      return {
        status: "completed",
        source: "simulated",
        body: "should not run"
      }
    }
  }) ?? rpcRouteModule

  const response = await handlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        createSendRequest({
          id: "rpc-waiting-approval-1",
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-waiting-approval-1",
              contextId: "context-waiting-approval-1",
              parts: [
                {
                  kind: "data",
                  data: createTaskContext({
                    workflowRunId: run.id
                  })
                }
              ],
              metadata: {
                idempotencyKey: "waiting-approval-idempotency-1",
                fromAgent: "external.user",
                toAgent: "openclaw:gengar"
              }
            }
          }
        })
      )
    })
  )
  const body = await readJson(response)

  assert.equal(response.status, 409)
  assert.deepEqual(body, {
    jsonrpc: "2.0",
    error: {
      code: -32005,
      message: "Workflow run is not runnable"
    },
    id: "rpc-waiting-approval-1"
  })
  assert.equal(invokeCalls, 0)
})

test("A2A task GET returns normalized task with ordered events and messages, POST cancel persists canceled state, and unknown ids return 404", async (t) => {
  const { repository } = await createRepository(t)
  let canceled = 0
  const rpcModule = await importA2ARoute()
  const taskModule = await importA2ATaskRoute()
  const rpcHandlers = rpcModule.createA2ARouteHandlers?.({
    repository,
    dispatchA2A: async () => ({
      status: "working",
      text: "Waiting for confirmation.",
      cancel: async () => {
        canceled += 1
      }
    })
  }) ?? rpcModule
  const taskHandlers = taskModule.createA2ATaskRouteHandlers?.({ repository }) ?? taskModule

  const createResponse = await rpcHandlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        createSendRequest({
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-task-route-1",
              contextId: "context-task-route-1",
              parts: [{ kind: "text", text: "start work" }],
              metadata: {
                idempotencyKey: "task-route-idempotency-1",
                fromAgent: "external.user",
                toAgent: "codex"
              }
            }
          }
        })
      )
    })
  )
  const created = await readJson(createResponse)
  const taskId = ((created.result as { id?: string })?.id ?? "") as string

  const getResponse = await taskHandlers.GET(
    new Request(`https://jormungand.test/api/a2a/tasks/${taskId}`),
    { params: Promise.resolve({ id: taskId }) }
  )
  const getBody = await readJson(getResponse)

  assert.equal(getResponse.status, 200)
  assert.equal((getBody.task as { id?: string }).id, taskId)
  assert.deepEqual(
    (getBody.events as Array<{ eventType: string }>).map((event) => event.eventType),
    ["message_queued", "message_accepted", "task_working"]
  )
  assert.equal((getBody.messages as Array<unknown>).length, 1)

  const cancelResponse = await taskHandlers.POST(
    new Request(`https://jormungand.test/api/a2a/tasks/${taskId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "cancel" })
    }),
    { params: Promise.resolve({ id: taskId }) }
  )
  const cancelBody = await readJson(cancelResponse)

  assert.equal(cancelResponse.status, 200)
  assert.equal((cancelBody.result as { status?: { state?: string } }).status?.state, "canceled")
  assert.equal(canceled, 1)

  const missingResponse = await taskHandlers.GET(
    new Request("https://jormungand.test/api/a2a/tasks/unknown-task"),
    { params: Promise.resolve({ id: "unknown-task" }) }
  )
  assert.equal(missingResponse.status, 404)
})

test("A2A task and audit records survive a SQLite reopen and reconstruct the redacted request, response, hashes, and lifecycle", async (t) => {
  const fixture = await createRestartableRepository(t)
  const rpcModule = await importA2ARoute()
  const taskModule = await importA2ATaskRoute()
  const auditModule = await importA2AAuditRoute()
  const rpcHandlers = rpcModule.createA2ARouteHandlers?.({
    repository: fixture.repository,
    dispatchA2A: async () => ({
      status: "completed",
      text: "Completed with token=downstream-token and Authorization: Bearer downstream-bearer",
      remoteTaskId: "remote-audit-reopen-1",
      artifacts: [
        {
          artifactId: "artifact-audit-reopen-1",
          name: "report",
          text: "token=artifact-token",
          metadata: {
            authorization: "Bearer artifact-bearer",
            note: "cookie=session-123"
          }
        }
      ],
      metadata: {
        secret: "downstream-secret",
        nested: {
          password: "downstream-password",
          ok: true
        }
      }
    })
  }) ?? rpcModule

  const request = createSendRequest({
    id: "rpc-audit-reopen-1",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: "message-audit-reopen-1",
        contextId: "context-audit-reopen-1",
        parts: [
          {
            kind: "data",
            data: {
              authorization: "Bearer upstream-bearer",
              detail: "token=upstream-token",
              nested: {
                secret: "upstream-secret",
                keep: "visible"
              }
            }
          }
        ],
        metadata: {
          idempotencyKey: "audit-reopen-idempotency-1",
          fromAgent: "external.user",
          toAgent: "codex"
        }
      }
    }
  })

  const createResponse = await rpcHandlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(request)
    })
  )
  const created = await readJson(createResponse)
  const taskId = ((created.result as { id?: string })?.id ?? "") as string

  fixture.restart()

  const taskHandlers = taskModule.createA2ATaskRouteHandlers?.({
    repository: fixture.repository
  }) ?? taskModule
  const auditHandlers = auditModule.createA2AAuditRouteHandlers?.({
    repository: fixture.repository
  }) ?? auditModule

  const taskResponse = await taskHandlers.GET(
    new Request(`https://jormungand.test/api/a2a/tasks/${taskId}`),
    { params: Promise.resolve({ id: taskId }) }
  )
  const taskBody = await readJson(taskResponse)

  const auditResponse = await auditHandlers.GET(
    new Request(`https://jormungand.test/api/a2a/audit/${taskId}`),
    { params: Promise.resolve({ id: taskId }) }
  )
  const auditBody = await readJson(auditResponse)

  const expectedRequestFrame = {
    jsonrpc: "2.0",
    id: "rpc-audit-reopen-1",
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: "message-audit-reopen-1",
        contextId: "context-audit-reopen-1",
        parts: [
          {
            kind: "data",
            data: {
              authorization: "[REDACTED]",
              detail: "token=[REDACTED]",
              nested: {
                secret: "[REDACTED]",
                keep: "visible"
              }
            }
          }
        ],
        metadata: {
          idempotencyKey: "audit-reopen-idempotency-1",
          fromAgent: "external.user",
          toAgent: "codex"
        }
      }
    }
  }
  const expectedResponseFrame = {
    result: {
      kind: "task",
      id: taskId,
      contextId: "context-audit-reopen-1",
      status: {
        state: "completed",
        message: {
          kind: "message",
          messageId: "message-audit-reopen-1:response",
          contextId: "context-audit-reopen-1",
          role: "agent",
          parts: [
            {
              kind: "text",
              text: "Completed with token=[REDACTED] and Authorization: Bearer [REDACTED]"
            }
          ]
        }
      },
      artifacts: [
        {
          artifactId: "artifact-audit-reopen-1",
          name: "report",
          parts: [
            {
              kind: "text",
              text: "token=[REDACTED]"
            }
          ],
          metadata: {
            authorization: "[REDACTED]",
            note: "cookie=[REDACTED]"
          }
        }
      ],
      metadata: {
        remoteTaskId: "remote-audit-reopen-1",
        secret: "[REDACTED]",
        nested: {
          password: "[REDACTED]",
          ok: true
        }
      }
    }
  }

  assert.equal(createResponse.status, 200)
  assert.equal(taskResponse.status, 200)
  assert.equal(auditResponse.status, 200)
  assert.equal((taskBody.task as { id?: string }).id, taskId)
  assert.equal((taskBody.task as { contextId?: string }).contextId, "context-audit-reopen-1")
  assert.equal((taskBody.task as { status?: { state?: string } }).status?.state, "completed")
  assert.equal((taskBody.messages as Array<{ requestSha256?: string }>)[0]?.requestSha256, sha256Json(expectedRequestFrame))
  assert.equal((taskBody.messages as Array<{ responseSha256?: string }>)[0]?.responseSha256, sha256Json(expectedResponseFrame))
  assert.deepEqual(
    (taskBody.events as Array<{ eventType: string }>).map((event) => event.eventType),
    ["message_queued", "message_accepted", "task_working", "task_artifact_updated", "task_completed"]
  )
  assert.deepEqual((auditBody.messages as Array<{ request?: unknown }>)[0]?.request, expectedRequestFrame)
  assert.deepEqual((auditBody.messages as Array<{ response?: unknown }>)[0]?.response, expectedResponseFrame)
  assert.deepEqual(
    (auditBody.timeline as Array<{ kind: string; eventType?: string }>).map((entry) =>
      entry.kind === "event" ? entry.eventType : entry.kind
    ),
    ["message", "message_queued", "message_accepted", "task_working", "task_artifact_updated", "task_completed"]
  )
})

test("A2A audit route returns redacted frames with request and response hashes", async (t) => {
  const { repository } = await createRepository(t)
  const rpcModule = await importA2ARoute()
  const auditModule = await importA2AAuditRoute()
  const rpcHandlers = rpcModule.createA2ARouteHandlers?.({
    repository,
    dispatchA2A: async () => ({
      status: "failed",
      text: "Denied. secret=hunter2",
      metadata: {
        authorization: "Bearer downstream-secret"
      }
    })
  }) ?? rpcModule
  const auditHandlers = auditModule.createA2AAuditRouteHandlers?.({ repository }) ?? auditModule

  const createResponse = await rpcHandlers.POST(
    new Request("https://jormungand.test/api/a2a", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(
        createSendRequest({
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-audit-route-1",
              contextId: "context-audit-route-1",
              parts: [
                {
                  kind: "data",
                  data: {
                    authorization: "Bearer upstream-secret",
                    detail: "token=abc123"
                  }
                }
              ],
              metadata: {
                idempotencyKey: "audit-route-idempotency-1",
                fromAgent: "external.user",
                toAgent: "codex"
              }
            }
          }
        })
      )
    })
  )
  const created = await readJson(createResponse)
  const taskId = ((created.result as { id?: string })?.id ?? "") as string

  const auditResponse = await auditHandlers.GET(
    new Request(`https://jormungand.test/api/a2a/audit/${taskId}`),
    { params: Promise.resolve({ id: taskId }) }
  )
  const auditBody = await readJson(auditResponse)
  const serialized = JSON.stringify(auditBody)

  assert.equal(auditResponse.status, 200)
  assert.equal((auditBody.task as { id?: string }).id, taskId)
  assert.equal(typeof (auditBody.messages as Array<{ requestSha256?: string }>)[0]?.requestSha256, "string")
  assert.equal(typeof (auditBody.messages as Array<{ responseSha256?: string }>)[0]?.responseSha256, "string")
  assert.ok(Array.isArray(auditBody.timeline))
  assert.doesNotMatch(serialized, /upstream-secret|downstream-secret|abc123|hunter2/)
  assert.match(serialized, /REDACTED/)
})
