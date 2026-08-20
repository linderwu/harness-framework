import type {} from "../app/api/conversation/live/route"

import assert from "node:assert/strict"
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import test, { describe } from "node:test"

import { createAgentLiveBus } from "../lib/agent-live-bus"
import { conversationCookieName } from "../lib/conversation-identity"

type ConversationLiveRouteModule = {
  GET: (request: Request) => Promise<Response>
  formatAgentLiveSse: (eventName: string, payload: unknown) => string
  createConversationLiveRouteHandlers?: (dependencies?: {
    bus?: ReturnType<typeof createAgentLiveBus>
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
})
