import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { TestContext } from "node:test"

import { A2AProtocolError } from "../lib/a2a-protocol"
import {
  createA2AServer,
  type A2AServerDispatchInput
} from "../lib/a2a-server"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

function createSendRequest(overrides: Record<string, unknown> = {}) {
  return {
    jsonrpc: "2.0",
    id: "rpc-1",
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: "message-1",
        contextId: "context-1",
        parts: [
          {
            kind: "text",
            text: "Please summarize the latest build."
          },
          {
            kind: "data",
            data: {
              repository: "github.com/acme/api",
              stage: "verification"
            }
          }
        ],
        metadata: {
          idempotencyKey: "client-idempotency-1",
          fromAgent: "external.user",
          toAgent: "jormungand"
        }
      },
      configuration: {
        acceptedOutputModes: ["text/plain", "application/json"]
      },
      metadata: {
        requestId: "client-request-1"
      }
    },
    ...overrides
  }
}

async function createServer(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-a2a-server-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)

  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  return { repository }
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

function matchesProtocolError(
  error: unknown,
  expected: { code: number; status: number; message?: string }
) {
  if (!(error instanceof A2AProtocolError)) {
    return false
  }

  const protocolError = error as A2AProtocolError
  return protocolError.code === expected.code &&
    protocolError.status === expected.status &&
    (expected.message === undefined || protocolError.message === expected.message)
}

test("A2A server rejects invalid JSON-RPC versions, methods, ids, parts, and oversized payloads", async (t) => {
  const { repository } = await createServer(t)
  const server = createA2AServer({
    repository,
    dispatch: async () => ({
      status: "completed",
      text: "done"
    })
  })

  await assert.rejects(
    () => server.send({ ...createSendRequest(), jsonrpc: "1.0" }),
    (error) =>
      matchesProtocolError(error, {
        code: -32600,
        status: 400,
        message: "jsonrpc must equal 2.0"
      })
  )

  await assert.rejects(
    () => server.send({ ...createSendRequest(), method: "tasks/run" }),
    (error) => matchesProtocolError(error, { code: -32601, status: 404 })
  )

  await assert.rejects(
    () =>
      server.send(
        createSendRequest({
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "",
              contextId: "context-1",
              parts: [{ kind: "text", text: "hi" }]
            }
          }
        })
      ),
    (error) =>
      matchesProtocolError(error, {
        code: -32602,
        status: 400,
        message: "messageId is required"
      })
  )

  await assert.rejects(
    () =>
      server.send(
        createSendRequest({
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-1",
              contextId: "context-1",
              parts: [{ kind: "binary", data: "nope" }]
            }
          }
        })
      ),
    (error) =>
      matchesProtocolError(error, {
        code: -32602,
        status: 400,
        message: "Unsupported message part kind: binary"
      })
  )

  await assert.rejects(
    () =>
      server.send(
        createSendRequest({
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-1",
              contextId: "context-1",
              parts: [
                {
                  kind: "text",
                  text: "x".repeat(16_385)
                }
              ]
            }
          }
        })
      ),
    (error) =>
      matchesProtocolError(error, {
        code: -32602,
        status: 400,
        message: "Text part exceeds the 16384 byte limit"
      })
  )
})

test("A2A server requires an explicit idempotency key in message or params metadata", async (t) => {
  const { repository } = await createServer(t)
  const server = createA2AServer({
    repository,
    dispatch: async () => ({
      status: "completed",
      text: "done"
    })
  })

  await assert.rejects(
    () =>
      server.send(
        createSendRequest({
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-1",
              contextId: "context-1",
              parts: [{ kind: "text", text: "hi" }],
              metadata: {
                fromAgent: "external.user",
                toAgent: "jormungand"
              }
            },
            metadata: {
              requestId: "missing-idem"
            }
          }
        })
      ),
    (error) =>
      matchesProtocolError(error, {
        code: -32602,
        status: 400,
        message: "idempotencyKey is required"
      })
  )

  await assert.rejects(
    () =>
      server.send(
        createSendRequest({
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-1",
              contextId: "context-1",
              parts: [{ kind: "text", text: "hi" }],
              metadata: {
                idempotencyKey: "   ",
                fromAgent: "external.user",
                toAgent: "jormungand"
              }
            }
          }
        })
      ),
    (error) =>
      matchesProtocolError(error, {
        code: -32602,
        status: 400,
        message: "idempotencyKey is required"
      })
  )

  const task = await server.send(
    createSendRequest({
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: "message-params-idempotency",
          contextId: "context-params-idempotency",
          parts: [{ kind: "text", text: "hi" }],
          metadata: {
            fromAgent: "external.user",
            toAgent: "jormungand"
          }
        },
        metadata: {
          idempotencyKey: "params-idempotency-1"
        }
      }
    })
  )

  assert.equal(task.status.state, "completed")
})

test("A2A server requires an explicit target and preserves authorization failures", async (t) => {
  const { repository } = await createServer(t)
  const server = createA2AServer({
    repository,
    authorize: ({ request }) => {
      if (request.toAgent !== "jormungand") {
        throw new A2AProtocolError("Target agent is not allowed", -32003, 403)
      }
    },
    dispatch: async () => ({
      status: "completed",
      text: "done"
    })
  })

  await assert.rejects(
    () =>
      server.send(
        createSendRequest({
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-no-target",
              contextId: "context-no-target",
              parts: [{ kind: "text", text: "hi" }],
              metadata: {
                idempotencyKey: "missing-target-1",
                fromAgent: "external.user"
              }
            }
          }
        })
      ),
    (error) =>
      matchesProtocolError(error, {
        code: -32602,
        status: 400,
        message: "message.metadata.toAgent or message.metadata.targetAgent is required"
      })
  )

  await assert.rejects(
    () =>
      server.send(
        createSendRequest({
          params: {
            message: {
              kind: "message",
              role: "user",
              messageId: "message-unauthorized-target",
              contextId: "context-unauthorized-target",
              parts: [{ kind: "text", text: "hi" }],
              metadata: {
                idempotencyKey: "unauthorized-target-1",
                fromAgent: "external.user",
                toAgent: "other-agent"
              }
            }
          }
        })
      ),
    (error) =>
      matchesProtocolError(error, {
        code: -32003,
        status: 403,
        message: "Target agent is not allowed"
      })
  )
})

test("A2A server send persists the inbound task and message before dispatch and returns a normalized task", async (t) => {
  const { repository } = await createServer(t)
  const dispatchCalls: string[] = []
  const server = createA2AServer({
    repository,
    dispatch: async (input: A2AServerDispatchInput) => {
      const { task, request } = input
      dispatchCalls.push(`${task.id}:${request.message.messageId}`)
      return {
        status: "completed",
        text: "Build verified.",
        artifacts: [
          {
            artifactId: "artifact-1",
            name: "summary",
            text: "All checks passed."
          },
          {
            artifactId: "artifact-2",
            name: "report",
            data: {
              failed: 0,
              total: 247
            }
          }
        ]
      }
    }
  })

  const task = await server.send(createSendRequest())

  assert.equal(task.kind, "task")
  assert.equal(task.contextId, "context-1")
  assert.equal(task.status.state, "completed")
  assert.equal(task.artifacts.length, 2)
  assert.equal(task.artifacts[0]?.parts[0]?.kind, "text")
  assert.equal(dispatchCalls.length, 1)

  const persistedTask = repository.getA2ATask(task.id)
  assert.ok(persistedTask)
  assert.equal(persistedTask.status, "completed")
  assert.equal(persistedTask.requestMessageId, "message-1")

  const messages = repository.listA2AMessages(task.id)
  assert.equal(messages.length, 1)
  assert.match(messages[0]?.requestJson ?? "", /message\/send/)

  const events = repository.listA2AEvents(task.id)
  assert.deepEqual(
    events.map((event) => event.eventType),
    [
      "message_queued",
      "message_accepted",
      "task_working",
      "task_artifact_updated",
      "task_artifact_updated",
      "task_completed"
    ]
  )
})

test("A2A server send reuses the existing task for duplicate idempotency keys", async (t) => {
  const { repository } = await createServer(t)
  let dispatchCount = 0
  const server = createA2AServer({
    repository,
    dispatch: async () => {
      dispatchCount += 1
      return {
        status: "completed",
        text: "Already done."
      }
    }
  })

  const first = await server.send(createSendRequest())
  const second = await server.send(createSendRequest({ id: "rpc-2" }))

  assert.equal(first.id, second.id)
  assert.equal(first.status.state, "completed")
  assert.equal(second.status.state, "completed")
  assert.equal(dispatchCount, 1)
  assert.equal(repository.listA2AMessages(first.id).length, 1)
})

test("A2A server concurrent duplicate sends share one fully initialized task and dispatch once", async (t) => {
  const { repository } = await createServer(t)
  const releaseDispatch = createDeferred<void>()
  let dispatchCount = 0
  const server = createA2AServer({
    repository,
    dispatch: async () => {
      dispatchCount += 1
      await releaseDispatch.promise
      return {
        status: "completed",
        text: "Concurrent duplicates resolved."
      }
    }
  })

  const request = createSendRequest({
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: "message-concurrent-1",
        contextId: "context-concurrent-1",
        parts: [{ kind: "text", text: "hi" }],
        metadata: {
          idempotencyKey: "concurrent-idempotency-1",
          fromAgent: "external.user",
          toAgent: "jormungand"
        }
      }
    }
  })

  const firstPromise = server.send(request)
  const secondPromise = server.send({ ...request, id: "rpc-2" })

  await new Promise((resolve) => setImmediate(resolve))

  const inFlightTask = repository.getA2ATaskByIdempotencyKey("concurrent-idempotency-1")
  assert.ok(inFlightTask)
  assert.equal(repository.listA2AMessages(inFlightTask.id).length, 1)
  assert.equal(repository.listA2AEvents(inFlightTask.id)[0]?.eventType, "message_queued")
  assert.equal(dispatchCount, 1)

  releaseDispatch.resolve()

  const [first, second] = await Promise.all([firstPromise, secondPromise])

  assert.equal(first.id, second.id)
  assert.equal(first.status.state, "completed")
  assert.equal(second.status.state, "completed")
  assert.equal(repository.listA2AMessages(first.id).length, 1)
  assert.equal(dispatchCount, 1)
})

test("A2A server cancelTask records a canceled lifecycle state and invokes the cancel callback", async (t) => {
  const { repository } = await createServer(t)
  let canceled = 0
  const server = createA2AServer({
    repository,
    dispatch: async () => ({
      status: "working",
      text: "Waiting for external input.",
      cancel: async () => {
        canceled += 1
      }
    })
  })

  const task = await server.send(createSendRequest())
  const canceledTask = await server.cancelTask(task.id)

  assert.equal(canceledTask.status.state, "canceled")
  assert.equal(canceled, 1)

  const persistedTask = repository.getA2ATask(task.id)
  assert.equal(persistedTask?.status, "canceled")
  assert.equal(
    repository.listA2AEvents(task.id).at(-1)?.eventType,
    "task_canceled"
  )
})

test("A2A server sendStream yields ordered lifecycle and artifact frames through the terminal state", async (t) => {
  const { repository } = await createServer(t)
  const server = createA2AServer({
    repository,
    dispatch: async () => ({
      status: "completed",
      text: "Streamed answer.",
      artifacts: [
        {
          artifactId: "artifact-stream-1",
          name: "answer",
          text: "Hello from the stream."
        }
      ]
    })
  })

  const frames = []
  for await (const frame of server.sendStream(createSendRequest({ method: "message/stream" }))) {
    frames.push(frame)
  }

  assert.deepEqual(
    frames.map((frame) => frame.event),
    [
      "message_queued",
      "message_accepted",
      "task_working",
      "task_artifact_updated",
      "task_completed"
    ]
  )
  assert.equal(frames.at(-1)?.data.status.state, "completed")
  assert.equal(frames[3]?.data.artifact?.artifactId, "artifact-stream-1")
})

test("A2A server sendStream emits queued and working frames before delayed dispatch resolves", async (t) => {
  const { repository } = await createServer(t)
  const releaseDispatch = createDeferred<void>()
  const server = createA2AServer({
    repository,
    dispatch: async () => {
      await releaseDispatch.promise
      return {
        status: "completed",
        text: "Stream finished.",
        artifacts: [
          {
            artifactId: "artifact-live-stream-1",
            name: "answer",
            text: "done"
          }
        ]
      }
    }
  })

  const iterator = server.sendStream(
    createSendRequest({
      id: "rpc-live-stream",
      method: "message/stream",
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: "message-live-stream",
          contextId: "context-live-stream",
          parts: [{ kind: "text", text: "stream" }],
          metadata: {
            idempotencyKey: "live-stream-idempotency-1",
            fromAgent: "external.user",
            toAgent: "jormungand"
          }
        }
      }
    })
  )

  const first = await iterator.next()
  const second = await iterator.next()
  const third = await iterator.next()

  assert.equal(first.value?.event, "message_queued")
  assert.equal(second.value?.event, "message_accepted")
  assert.equal(third.value?.event, "task_working")

  const persistedTask = repository.getA2ATaskByIdempotencyKey("live-stream-idempotency-1")
  assert.ok(persistedTask)
  assert.equal(persistedTask.status, "working")

  releaseDispatch.resolve()

  const remaining = []
  for await (const frame of iterator) {
    remaining.push(frame)
  }

  assert.deepEqual(
    remaining.map((frame) => frame.event),
    ["task_artifact_updated", "task_completed"]
  )
})

test("A2A server stores only redacted request and response frames", async (t) => {
  const { repository } = await createServer(t)
  const server = createA2AServer({
    repository,
    dispatch: async () => ({
      status: "failed",
      text: "Denied.",
      artifacts: [
        {
          artifactId: "artifact-secret-1",
          name: "error",
          data: {
            authorization: "Bearer downstream-secret",
            detail: "should be hidden"
          }
        }
      ],
      metadata: {
        token: "secret-token"
      }
    })
  })

  const task = await server.send(
    createSendRequest({
      params: {
        message: {
          kind: "message",
          role: "user",
          messageId: "message-secret-1",
          contextId: "context-secret-1",
          parts: [
            {
              kind: "data",
              data: {
                password: "open-sesame",
                safe: true,
                note: "Authorization: Bearer upstream-secret",
                detail: "token=hunter2 cookie=sessionid=abc123"
              }
            }
          ],
          metadata: {
            idempotencyKey: "client-idempotency-secret-1",
            authorization: "Bearer upstream-secret",
            toAgent: "jormungand"
          }
        }
      }
    })
  )

  const messages = repository.listA2AMessages(task.id)
  assert.equal(messages.length, 1)
  assert.match(messages[0]?.requestJson ?? "", /REDACTED/)
  assert.doesNotMatch(messages[0]?.requestJson ?? "", /open-sesame|upstream-secret|hunter2|abc123/)
  assert.match(messages[0]?.requestJson ?? "", /Authorization: Bearer \[REDACTED\]/)
  assert.match(messages[0]?.responseJson ?? "", /REDACTED/)
  assert.doesNotMatch(messages[0]?.responseJson ?? "", /downstream-secret|secret-token/)
})
