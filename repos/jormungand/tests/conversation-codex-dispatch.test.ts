import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  dispatchCodexConversationEntry,
  getCodexConversationState
} from "../lib/codex-conversation"
import { ConversationLifecycleService } from "../lib/conversation-lifecycle/service"
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

test("Codex polling keeps a claimed lifecycle Turn running until TX3 applies the raw terminal body", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-codex-lifecycle-poll-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  const conversationId = "conversation:codex-lifecycle-poll"
  await repository.createConversation({ id: conversationId, title: "Codex lifecycle poll" })
  const submitted = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "lifecycle prompt",
    idempotencyKey: "codex-lifecycle-poll",
    responseRole: "agent"
  })
  const claim = await lifecycle.claimNextTurn({
    conversationId,
    leaseOwner: "codex-lifecycle-worker",
    leaseDurationMs: 60_000
  })
  assert.ok(claim && !("rejected" in claim))
  if (!claim || "rejected" in claim) throw new Error("Expected lifecycle claim")
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-codex-lifecycle-poll",
    codexThreadId: "thread-codex-lifecycle-poll",
    status: "running",
    turnStatus: "inProgress",
    cursor: 0
  })

  const rawFinalText = "  raw Codex terminal body  \n"
  const originalFetch = globalThis.fetch
  const originalBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith("/sessions/bridge-codex-lifecycle-poll/turns")) {
      return jsonResponse({ status: "running", turnStatus: "inProgress" }, 202)
    }
    if (url.includes("/sessions/bridge-codex-lifecycle-poll/events?after=")) {
      return jsonResponse({
        id: "bridge-codex-lifecycle-poll",
        threadId: "thread-codex-lifecycle-poll",
        status: "idle",
        turnStatus: "completed",
        cursor: 1,
        finalText: rawFinalText,
        liveText: rawFinalText,
        events: [{
          id: "terminal-event",
          sequence: 1,
          createdAt: new Date().toISOString(),
          type: "turn_completed",
          text: rawFinalText
        }],
        nextCursor: 1
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = originalBridgeUrl
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const polled = await getCodexConversationState(repository, conversationId)
  assert.equal(polled.session?.finalText, rawFinalText)
  assert.equal(repository.getCodexSession(conversationId)?.cursor, 1)
  assert.equal(repository.getCodexSession(conversationId)?.turnStatus, "completed")
  assert.equal(repository.getExecutionJob(submitted.jobId)?.status, "running")
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => [entry.status, entry.content]),
    [
      ["running", "lifecycle prompt"],
      ["running", "Queued for agent response..."]
    ]
  )

  const outcome = await dispatchCodexConversationEntry({
    repository,
    conversationId,
    userEntryId: submitted.userEntryId,
    responseEntryId: submitted.responseEntryId,
    pollIntervalMs: 1
  })
  assert.deepEqual(outcome, { status: "completed", body: rawFinalText })
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => [entry.status, entry.content]),
    [
      ["running", "lifecycle prompt"],
      ["running", "Queued for agent response..."]
    ]
  )

  const settled = await lifecycle.settleTurn({
    conversationId,
    userEntryId: submitted.userEntryId,
    responseEntryId: submitted.responseEntryId,
    jobId: submitted.jobId,
    idempotencyKey: claim.idempotencyKey,
    leaseOwner: claim.leaseOwner,
    outcome: { kind: "completed", body: outcome.body, deliveryState: "confirmed" }
  })
  assert.equal(settled.applied, true)
  assert.equal(repository.getExecutionJob(submitted.jobId)?.status, "completed")
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => [entry.status, entry.content]),
    [
      ["completed", "lifecycle prompt"],
      ["completed", rawFinalText]
    ]
  )
})

test("Codex native thread sync does not project onto a claimed lifecycle Turn before TX3", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-codex-lifecycle-native-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  const conversationId = "conversation:codex-lifecycle-native"
  await repository.createConversation({ id: conversationId, title: "Codex lifecycle native" })
  const submitted = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "lifecycle native prompt",
    idempotencyKey: "codex-lifecycle-native",
    responseRole: "agent"
  })
  const claim = await lifecycle.claimNextTurn({
    conversationId,
    leaseOwner: "codex-lifecycle-native-worker",
    leaseDurationMs: 60_000
  })
  assert.ok(claim && !("rejected" in claim))
  if (!claim || "rejected" in claim) throw new Error("Expected lifecycle claim")
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-codex-lifecycle-native",
    codexThreadId: "thread-codex-lifecycle-native",
    status: "running",
    turnStatus: "inProgress",
    cursor: 0
  })
  await repository.recordCodexSyncItem({
    conversationId,
    nativeThreadId: "thread-codex-lifecycle-native",
    nativeTurnId: "turn-codex-lifecycle-native",
    nativeItemId: "harness-user",
    source: "harness",
    kind: "userMessage",
    conversationEntryId: submitted.userEntryId,
    contentHash: "lifecycle native prompt"
  })

  const rawFinalText = "  raw native lifecycle final  \n"
  const originalFetch = globalThis.fetch
  const originalBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/sessions/bridge-codex-lifecycle-native/events?after=")) {
      return jsonResponse({
        id: "bridge-codex-lifecycle-native",
        threadId: "thread-codex-lifecycle-native",
        status: "idle",
        turnStatus: "completed",
        cursor: 1,
        finalText: rawFinalText,
        events: [],
        nextCursor: 1
      })
    }
    if (url.endsWith("/sessions/bridge-codex-lifecycle-native/thread")) {
      return jsonResponse({
        id: "bridge-codex-lifecycle-native",
        threadId: "thread-codex-lifecycle-native",
        thread: {
          id: "thread-codex-lifecycle-native",
          name: "Lifecycle native",
          turns: [{
            id: "turn-codex-lifecycle-native",
            status: "completed",
            items: [
              { id: "harness-user", type: "userMessage", content: [{ type: "text", text: "lifecycle native prompt" }] },
              { id: "native-response", type: "agentMessage", text: "native projection must not settle", phase: "final_answer" }
            ]
          }]
        }
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = originalBridgeUrl
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  await getCodexConversationState(repository, conversationId)

  assert.equal(repository.getCodexSession(conversationId)?.nativeCursor, "turn-codex-lifecycle-native")
  assert.equal(repository.listCodexSyncItems(conversationId).length, 1)
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => [entry.status, entry.content]),
    [
      ["running", "lifecycle native prompt"],
      ["running", "Queued for agent response..."]
    ]
  )

  const settled = await lifecycle.settleTurn({
    conversationId,
    userEntryId: submitted.userEntryId,
    responseEntryId: submitted.responseEntryId,
    jobId: submitted.jobId,
    idempotencyKey: claim.idempotencyKey,
    leaseOwner: claim.leaseOwner,
    outcome: { kind: "completed", body: rawFinalText, deliveryState: "confirmed" }
  })
  assert.equal(settled.applied, true)
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => [entry.status, entry.content]),
    [
      ["completed", "lifecycle native prompt"],
      ["completed", rawFinalText]
    ]
  )
})

test("Codex polling preserves a claimed manager response until TX3", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-codex-lifecycle-manager-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  const conversationId = "conversation:codex-lifecycle-manager"
  await repository.createConversation({ id: conversationId, title: "Codex lifecycle manager" })
  const submitted = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "manager lifecycle prompt",
    idempotencyKey: "codex-lifecycle-manager",
    responseRole: "manager"
  })
  const claim = await lifecycle.claimNextTurn({
    conversationId,
    leaseOwner: "codex-lifecycle-manager-worker",
    leaseDurationMs: 60_000
  })
  assert.ok(claim && !("rejected" in claim))
  if (!claim || "rejected" in claim) throw new Error("Expected lifecycle claim")
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-codex-lifecycle-manager",
    codexThreadId: "thread-codex-lifecycle-manager",
    status: "running",
    turnStatus: "inProgress",
    cursor: 0
  })

  const rawFinalText = "  manager lifecycle final  \n"
  const originalFetch = globalThis.fetch
  const originalBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith("/sessions/bridge-codex-lifecycle-manager/turns")) {
      return jsonResponse({ status: "running", turnStatus: "inProgress" }, 202)
    }
    if (url.includes("/sessions/bridge-codex-lifecycle-manager/events?after=")) {
      return jsonResponse({
        id: "bridge-codex-lifecycle-manager",
        threadId: "thread-codex-lifecycle-manager",
        status: "idle",
        turnStatus: "completed",
        cursor: 1,
        finalText: rawFinalText,
        events: [],
        nextCursor: 1
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = originalBridgeUrl
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const outcome = await dispatchCodexConversationEntry({
    repository,
    conversationId,
    userEntryId: submitted.userEntryId,
    responseEntryId: submitted.responseEntryId,
    pollIntervalMs: 1
  })
  assert.deepEqual(outcome, { status: "completed", body: rawFinalText })
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => [entry.role, entry.status, entry.content]),
    [
      ["user", "running", "manager lifecycle prompt"],
      ["manager", "running", "Queued for agent response..."]
    ]
  )

  const settled = await lifecycle.settleTurn({
    conversationId,
    userEntryId: submitted.userEntryId,
    responseEntryId: submitted.responseEntryId,
    jobId: submitted.jobId,
    idempotencyKey: claim.idempotencyKey,
    leaseOwner: claim.leaseOwner,
    outcome: { kind: "completed", body: outcome.body, deliveryState: "confirmed" }
  })
  assert.equal(settled.applied, true)
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => [entry.role, entry.status, entry.content]),
    [
      ["user", "completed", "manager lifecycle prompt"],
      ["manager", "completed", rawFinalText]
    ]
  )
})
