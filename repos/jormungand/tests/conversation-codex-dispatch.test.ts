import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { dispatchCodexConversationEntry } from "../lib/codex-conversation"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

test("Codex dispatch waits for terminal bridge state and excludes future queued messages", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-codex-dispatch-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const user = await repository.insertConversation({
    workflowRunId: "conversation:codex-dispatch",
    role: "user",
    agentId: "codex",
    content: "first prompt",
    importance: "normal",
    status: "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "codex-dispatch:first"
  })
  const response = await repository.insertConversation({
    workflowRunId: "conversation:codex-dispatch",
    role: "agent",
    agentId: "codex",
    content: "Queued for agent response...",
    importance: "important",
    status: "queued",
    replyToId: user.entry.id,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "codex-dispatch:first:response"
  })
  await repository.insertConversation({
    workflowRunId: "conversation:codex-dispatch",
    role: "user",
    agentId: "codex",
    content: "future prompt",
    importance: "normal",
    status: "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "codex-dispatch:future"
  })
  await repository.upsertCodexSession({
    conversationId: "conversation:codex-dispatch",
    bridgeSessionId: "bridge-codex-dispatch",
    codexThreadId: "thread-codex-dispatch",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })

  const originalFetch = globalThis.fetch
  const originalBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  const requests: Array<{ url: string; body?: string }> = []
  let eventReads = 0
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    requests.push({ url, body: typeof init?.body === "string" ? init.body : undefined })
    if (url.endsWith("/sessions/bridge-codex-dispatch/turns")) {
      return jsonResponse({ status: "running", turnStatus: "inProgress" }, 202)
    }
    if (url.includes("/sessions/bridge-codex-dispatch/events?after=")) {
      eventReads += 1
      return jsonResponse(eventReads === 1
        ? {
            id: "bridge-codex-dispatch",
            threadId: "thread-codex-dispatch",
            status: "running",
            turnStatus: "inProgress",
            cursor: 1,
            liveText: "partial",
            events: [{ id: "event-1", sequence: 1, createdAt: new Date().toISOString(), type: "assistant_delta", text: "partial" }],
            nextCursor: 1
          }
        : {
            id: "bridge-codex-dispatch",
            threadId: "thread-codex-dispatch",
            status: "idle",
            turnStatus: "completed",
            cursor: 2,
            finalText: "final answer",
            liveText: "final answer",
            events: [{ id: "event-2", sequence: 2, createdAt: new Date().toISOString(), type: "turn_completed", text: "final answer" }],
            nextCursor: 2
          })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = originalBridgeUrl
  })

  const result = await dispatchCodexConversationEntry({
    repository,
    conversationId: "conversation:codex-dispatch",
    userEntryId: user.entry.id,
    responseEntryId: response.entry.id,
    pollIntervalMs: 1
  })

  assert.equal(result.status, "completed")
  assert.equal(result.body, "final answer")
  const turnRequest = requests.find((request) => request.url.endsWith("/turns"))
  assert.ok(turnRequest?.body)
  assert.match(turnRequest.body!, /first prompt/)
  assert.doesNotMatch(turnRequest.body!, /future prompt/)
  assert.equal(repository.getConversationEntry(user.entry.id)?.status, "completed")
  assert.equal(repository.getConversationEntry(response.entry.id)?.content, "final answer")
})
