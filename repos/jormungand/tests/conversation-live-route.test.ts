import type {} from "../app/api/conversation/live/route"

import assert from "node:assert/strict"
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { createAgentLiveBus } from "../lib/agent-live-bus"

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
    new Request("https://jormungand.test/api/conversation/live")
  )

  assert.equal(response.status, 400)
  assert.doesNotMatch(response.headers.get("content-type") ?? "", /text\/event-stream/i)
  assert.deepEqual(await response.json(), { error: "conversationId is required" })
})

test("response is text/event-stream and only requested conversation events are emitted", async () => {
  const bus = createAgentLiveBus({ maxEvents: 2 })
  const route = await importConversationLiveRoute()
  const handlers = route.createConversationLiveRouteHandlers?.({ bus }) ?? route

  bus.publish({
    id: "conversation-1-1",
    sequence: 1,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "status",
    createdAt: "2026-08-20T00:00:01.000Z",
    message: "queued"
  })
  bus.publish({
    id: "conversation-2-1",
    sequence: 1,
    conversationId: "conversation-2",
    agentId: "openclaw.rowlet",
    type: "status",
    createdAt: "2026-08-20T00:00:01.000Z",
    message: "other conversation"
  })
  bus.publish({
    id: "conversation-1-2",
    sequence: 2,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "status",
    createdAt: "2026-08-20T00:00:02.000Z",
    message: "running"
  })

  const response = await handlers.GET(
    new Request("https://jormungand.test/api/conversation/live?conversationId=conversation-1")
  )

  bus.publish({
    id: "conversation-2-2",
    sequence: 2,
    conversationId: "conversation-2",
    agentId: "openclaw.rowlet",
    type: "status",
    createdAt: "2026-08-20T00:00:02.000Z",
    message: "still other conversation"
  })
  bus.publish({
    id: "conversation-1-3",
    sequence: 3,
    conversationId: "conversation-1",
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
  assert.match(body, /"conversationId":"conversation-1"/)
  assert.match(body, /"sequence":1/)
  assert.match(body, /"sequence":2/)
  assert.match(body, /"sequence":3/)
  assert.doesNotMatch(body, /other conversation|still other conversation/)
  assert.ok(body.indexOf("\"sequence\":1") < body.indexOf("\"sequence\":3"))
})
