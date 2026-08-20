import type {} from "../app/api/conversation/live/route"

import assert from "node:assert/strict"
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import test, { describe } from "node:test"

import { createAgentLiveBus } from "../lib/agent-live-bus"
import type { AgentLiveEvent } from "../lib/agent-live-events"
import { conversationCookieName } from "../lib/conversation-identity"

type ConversationLiveRouteModule = {
  GET: (request: Request) => Promise<Response>
  formatAgentLiveSse: (eventName: string, payload: unknown) => string
  createConversationLiveRouteHandlers?: (dependencies?: {
    bus?: {
      getSnapshot: (conversationId: string) => {
        conversationId: string
        events: AgentLiveEvent[]
        terminal: boolean
        lastSequence: number
      }
      subscribe: (
        conversationId: string,
        listener: (event: AgentLiveEvent) => void
      ) => { unsubscribe(): void }
    } | ReturnType<typeof createAgentLiveBus>
  }) => {
    GET: (request: Request) => Promise<Response>
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

async function importConversationLiveRoute() {
  await ensureCompiledAlias()
  return await import("../app/api/conversation/live/route") as ConversationLiveRouteModule
}

async function readResponseText(response: Response) {
  const reader = response.body?.getReader()
  assert.ok(reader)
  const decoder = new TextDecoder()
  let body = ""

  while (true) {
    const chunk = await reader.read()
    if (chunk.done) {
      break
    }
    body += decoder.decode(chunk.value, { stream: true })
  }

  body += decoder.decode()
  return body
}

describe("conversation live route", { concurrency: false }, () => {
  test("SSE formatting contains event and JSON data", async () => {
    const route = await importConversationLiveRoute()

    assert.equal(
      route.formatAgentLiveSse("agent-live", { type: "status", sequence: 4 }),
      "event: agent-live\ndata: {\"type\":\"status\",\"sequence\":4}\n\n"
    )
  })

  test("missing conversationId rejected", async () => {
    const route = await importConversationLiveRoute()
    const handlers = route.createConversationLiveRouteHandlers?.({ bus: createAgentLiveBus() }) ?? route

    const response = await handlers.GET(
      new Request("https://jormungand.test/api/conversation/live", {
        headers: {
          Cookie: `${conversationCookieName}=conversation:11111111-1111-4111-8111-111111111111`
        }
      })
    )

    assert.equal(response.status, 400)
    assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/event-stream/i)
    assert.deepEqual(await response.json(), { error: "conversationId is required" })
  })

  test("invalid explicit conversationId is rejected even when the cookie is otherwise valid", async () => {
    const route = await importConversationLiveRoute()
    const handlers = route.createConversationLiveRouteHandlers?.({ bus: createAgentLiveBus() }) ?? route

    const response = await handlers.GET(
      new Request("https://jormungand.test/api/conversation/live?conversationId=conversation-1", {
        headers: {
          Cookie: `${conversationCookieName}=conversation:11111111-1111-4111-8111-111111111111`
        }
      })
    )

    assert.equal(response.status, 400)
    assert.deepEqual(await response.json(), { error: "conversationId is invalid" })
  })

  test("explicit query conversationId refreshes a mismatched cookie using the established route semantics", async () => {
    const bus = createAgentLiveBus()
    const route = await importConversationLiveRoute()
    const handlers = route.createConversationLiveRouteHandlers?.({ bus }) ?? route
    const requestedConversationId = "conversation:22222222-2222-4222-8222-222222222222"

    bus.publish({
      id: `${requestedConversationId}-1`,
      sequence: 1,
      conversationId: requestedConversationId,
      agentId: "openclaw.rowlet",
      type: "completed",
      createdAt: "2026-08-20T00:00:03.000Z",
      message: "done"
    })

    const response = await handlers.GET(
      new Request(`https://jormungand.test/api/conversation/live?conversationId=${requestedConversationId}`, {
        headers: {
          Cookie: `${conversationCookieName}=conversation:11111111-1111-4111-8111-111111111111`
        }
      })
    )

    const body = await readResponseText(response)
    const setCookie = response.headers.get("set-cookie") ?? ""

    assert.equal(response.status, 200)
    assert.match(setCookie, /jormungand-conversation-id=/i)
    assert.match(setCookie, /22222222-2222-4222-8222-222222222222/)
    assert.match(body, /"conversationId":"conversation:22222222-2222-4222-8222-222222222222"/)
  })

  test("response is text/event-stream and only requested conversation events are emitted", async () => {
    const bus = createAgentLiveBus({ maxEvents: 2 })
    const route = await importConversationLiveRoute()
    const handlers = route.createConversationLiveRouteHandlers?.({ bus }) ?? route
    const requestedConversationId = "conversation:11111111-1111-4111-8111-111111111111"
    const otherConversationId = "conversation:22222222-2222-4222-8222-222222222222"

    bus.publish({
      id: `${requestedConversationId}-1`,
      sequence: 1,
      conversationId: requestedConversationId,
      agentId: "openclaw.rowlet",
      type: "status",
      createdAt: "2026-08-20T00:00:01.000Z",
      message: "queued"
    })
    bus.publish({
      id: `${otherConversationId}-1`,
      sequence: 1,
      conversationId: otherConversationId,
      agentId: "openclaw.rowlet",
      type: "status",
      createdAt: "2026-08-20T00:00:01.000Z",
      message: "other conversation"
    })
    bus.publish({
      id: `${requestedConversationId}-2`,
      sequence: 2,
      conversationId: requestedConversationId,
      agentId: "openclaw.rowlet",
      type: "status",
      createdAt: "2026-08-20T00:00:02.000Z",
      message: "running"
    })

    const response = await handlers.GET(
      new Request(`https://jormungand.test/api/conversation/live?conversationId=${requestedConversationId}`)
    )

    bus.publish({
      id: `${otherConversationId}-2`,
      sequence: 2,
      conversationId: otherConversationId,
      agentId: "openclaw.rowlet",
      type: "status",
      createdAt: "2026-08-20T00:00:02.000Z",
      message: "still other conversation"
    })
    bus.publish({
      id: `${requestedConversationId}-3`,
      sequence: 3,
      conversationId: requestedConversationId,
      agentId: "openclaw.rowlet",
      type: "completed",
      createdAt: "2026-08-20T00:00:03.000Z",
      message: "done"
    })

    const body = await readResponseText(response)

    assert.equal(response.status, 200)
    assert.match(response.headers.get("cache-control") ?? "", /no-cache, no-transform/i)
    assert.match(response.headers.get("connection") ?? "", /keep-alive/i)
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream;\s*charset=utf-8/i)
    assert.match(body, /event: ready/)
    assert.match(body, /"conversationId":"conversation:11111111-1111-4111-8111-111111111111"/)
    assert.match(body, /"sequence":1/)
    assert.match(body, /"sequence":2/)
    assert.match(body, /"sequence":3/)
    assert.doesNotMatch(body, /other conversation|still other conversation/)
    assert.ok(body.indexOf("\"sequence\":1") < body.indexOf("\"sequence\":3"))
  })

  test("reader cancel unsubscribes the bus listener immediately", async () => {
    const route = await importConversationLiveRoute()
    const requestedConversationId = "conversation:33333333-3333-4333-8333-333333333333"
    let unsubscribeCalls = 0
    let subscribeCalls = 0

    const handlers = route.createConversationLiveRouteHandlers?.({
      bus: {
        getSnapshot(conversationId) {
          return {
            conversationId,
            events: [],
            terminal: false,
            lastSequence: -1
          }
        },
        subscribe(
          conversationId: string,
          listener: (event: {
            id: string
            sequence: number
            conversationId: string
            agentId: "openclaw.rowlet"
            type: "status"
            createdAt: string
            message?: string
          }) => void
        ) {
          void listener
          subscribeCalls += 1
          assert.equal(conversationId, requestedConversationId)
          return {
            unsubscribe() {
              unsubscribeCalls += 1
            }
          }
        }
      }
    }) ?? route

    const response = await handlers.GET(
      new Request(`https://jormungand.test/api/conversation/live?conversationId=${requestedConversationId}`)
    )

    const reader = response.body?.getReader()
    assert.ok(reader)

    const firstChunk = await reader.read()
    assert.equal(firstChunk.done, false)
    await reader.cancel("client closed")

    assert.equal(subscribeCalls, 1)
    assert.equal(unsubscribeCalls, 1)
  })

  test("a new started event keeps the SSE stream open past an old terminal snapshot", async () => {
    const route = await importConversationLiveRoute()
    const requestedConversationId = "conversation:44444444-4444-4444-8444-444444444444"
    const received: string[] = []
    let unsubscribeCalls = 0
    let listener: ((event: AgentLiveEvent) => void) | undefined

    const handlers = route.createConversationLiveRouteHandlers?.({
      bus: {
        getSnapshot(conversationId) {
          return {
            conversationId,
            events: [
              {
                id: "old-completed",
                sequence: 2,
                conversationId,
                agentId: "openclaw.rowlet",
                type: "completed",
                createdAt: "2026-08-20T00:00:02.000Z",
                message: "old run done",
                metadata: { runId: "run-1" }
              }
            ],
            terminal: true,
            lastSequence: 2
          }
        },
        subscribe(conversationId: string, next: (event: AgentLiveEvent) => void) {
          assert.equal(conversationId, requestedConversationId)
          listener = next
          next({
            id: "new-started",
            sequence: 3,
            conversationId,
            agentId: "openclaw.rowlet",
            type: "started",
            createdAt: "2026-08-20T00:00:03.000Z",
            message: "new run started",
            metadata: { runId: "run-2" }
          })
          return {
            unsubscribe() {
              unsubscribeCalls += 1
            }
          }
        }
      }
    }) ?? route

    const response = await handlers.GET(
      new Request(`https://jormungand.test/api/conversation/live?conversationId=${requestedConversationId}`)
    )

    const reader = response.body?.getReader()
    assert.ok(reader)

    for (let index = 0; index < 3; index += 1) {
      const chunk = await reader.read()
      assert.equal(chunk.done, false)
      received.push(new TextDecoder().decode(chunk.value))
    }

    listener?.({
      id: "new-status",
      sequence: 4,
      conversationId: requestedConversationId,
      agentId: "openclaw.rowlet",
      type: "status",
      createdAt: "2026-08-20T00:00:04.000Z",
      message: "new run still active",
      metadata: { runId: "run-2" }
    })

    const fourthChunk = await reader.read()
    assert.equal(fourthChunk.done, false)
    received.push(new TextDecoder().decode(fourthChunk.value))

    await reader.cancel("client closed")

    const body = received.join("")
    assert.match(body, /old run done/)
    assert.match(body, /new run started/)
    assert.match(body, /new run still active/)
    assert.equal(unsubscribeCalls, 1)
  })
})
