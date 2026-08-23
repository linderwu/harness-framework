import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  dispatchCodexConversationEntry,
  getCodexConversationState,
  postCodexConversationMessage
} from "../lib/codex-conversation"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

test("imports a Codex desktop turn from the native thread snapshot", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-sync-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-sync"
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-native-sync",
    codexThreadId: "thread-native-sync",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const previousBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    if (previousBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = previousBridgeUrl
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/events?after=")) {
      return jsonResponse({
        id: "bridge-native-sync",
        threadId: "thread-native-sync",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0
      })
    }
    if (url.endsWith("/sessions/bridge-native-sync/thread")) {
      return jsonResponse({
        id: "bridge-native-sync",
        threadId: "thread-native-sync",
        status: "idle",
        turnStatus: "completed",
        thread: {
          id: "thread-native-sync",
          turns: [{
            id: "turn-desktop",
            status: "completed",
            items: [
              {
                id: "item-user",
                type: "userMessage",
                content: [{ type: "text", text: "desktop message" }]
              },
              {
                id: "item-agent",
                type: "agentMessage",
                text: "desktop reply",
                phase: "final_answer"
              }
            ]
          }]
        }
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const state = await getCodexConversationState(repository, conversationId)

  assert.deepEqual(state.entries.map((entry) => entry.content), [
    "desktop message",
    "desktop reply"
  ])
  assert.equal(repository.listCodexSyncItems(conversationId).length, 2)

  await getCodexConversationState(repository, conversationId)
  assert.equal(repository.listConversation(conversationId).length, 2)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 2)
})

test("does not duplicate a Harness user entry when native turn is ledgered as outbound", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-outbound-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-outbound"
  const user = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content: "Harness prompt",
    importance: "normal",
    status: "running",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "harness-prompt"
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-native-outbound",
    codexThreadId: "thread-native-outbound",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })
  await repository.recordCodexSyncItem({
    conversationId,
    nativeThreadId: "thread-native-outbound",
    nativeTurnId: "turn-harness",
    nativeItemId: "item-harness-user",
    source: "harness",
    kind: "userMessage",
    conversationEntryId: user.entry.id,
    contentHash: "harness-prompt"
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const previousBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    if (previousBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = previousBridgeUrl
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/events?after=")) {
      return jsonResponse({
        id: "bridge-native-outbound",
        threadId: "thread-native-outbound",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0
      })
    }
    if (url.endsWith("/sessions/bridge-native-outbound/thread")) {
      return jsonResponse({
        id: "bridge-native-outbound",
        threadId: "thread-native-outbound",
        thread: {
          id: "thread-native-outbound",
          turns: [{
            id: "turn-harness",
            status: "completed",
            items: [
              {
                id: "item-harness-user",
                type: "userMessage",
                content: [{ type: "text", text: "Harness prompt" }]
              },
              {
                id: "item-harness-agent",
                type: "agentMessage",
                text: "Harness reply",
                phase: "final_answer"
              }
            ]
          }]
        }
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const state = await getCodexConversationState(repository, conversationId)

  assert.deepEqual(state.entries.map((entry) => entry.content), [
    "Harness prompt",
    "Harness reply"
  ])
  assert.equal(state.entries.filter((entry) => entry.role === "user").length, 1)
})

test("recreates only the Bridge session while resuming the durable native thread", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-resume-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-resume"
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-old",
    codexThreadId: "thread-existing",
    nativeName: "Harness · Existing",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const previousBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    if (previousBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = previousBridgeUrl
  })
  const originalFetch = globalThis.fetch
  const sessionBodies: unknown[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/sessions/bridge-old/events?after=0")) {
      return jsonResponse({ error: "session not found" }, 404)
    }
    if (url.endsWith("/sessions")) {
      sessionBodies.push(JSON.parse(String(init?.body ?? "{}")))
      return jsonResponse({
        id: "bridge-new",
        threadId: "thread-existing",
        status: "idle",
        turnStatus: "completed",
        cursor: 0
      }, 201)
    }
    if (url.endsWith("/sessions/bridge-new/turns")) {
      return jsonResponse({ status: "running", turnStatus: "inProgress" }, 202)
    }
    if (url.endsWith("/sessions/bridge-new/events?after=0")) {
      return jsonResponse({
        id: "bridge-new",
        threadId: "thread-existing",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0,
        finalText: "resumed reply"
      })
    }
    if (url.endsWith("/sessions/bridge-new/thread")) {
      return jsonResponse({
        id: "bridge-new",
        threadId: "thread-existing",
        thread: { id: "thread-existing", name: "Harness · Existing", turns: [] }
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  await postCodexConversationMessage({
    repository,
    conversationId,
    content: "continue",
    idempotencyKey: "resume-message"
  })

  assert.deepEqual(sessionBodies, [{
    threadId: "thread-existing",
    name: "Harness · Existing"
  }])
  assert.equal(repository.getCodexSession(conversationId)?.bridgeSessionId, "bridge-new")
  assert.equal(repository.getCodexSession(conversationId)?.codexThreadId, "thread-existing")
})

test("creates a lineage-linked replacement only after native thread loss is confirmed", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-replacement-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-replacement"
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-old-replacement",
    codexThreadId: "thread-lost",
    nativeName: "Harness · Replacement",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const previousBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    if (previousBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = previousBridgeUrl
  })
  const originalFetch = globalThis.fetch
  const sessionBodies: unknown[] = []
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/sessions/bridge-old-replacement/events?after=0")) {
      return jsonResponse({ error: "session not found" }, 404)
    }
    if (url.endsWith("/sessions") && init?.method === "POST") {
      const body = JSON.parse(String(init.body ?? "{}")) as { threadId?: string }
      sessionBodies.push(body)
      if (body.threadId) return jsonResponse({ error: "thread not found" }, 404)
      return jsonResponse({
        id: "bridge-replacement",
        threadId: "thread-replacement",
        status: "idle",
        turnStatus: "completed",
        cursor: 0
      }, 201)
    }
    if (url.endsWith("/sessions/bridge-replacement/turns")) {
      return jsonResponse({ status: "running", turnStatus: "inProgress" }, 202)
    }
    if (url.endsWith("/sessions/bridge-replacement/events?after=0")) {
      return jsonResponse({
        id: "bridge-replacement",
        threadId: "thread-replacement",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0,
        finalText: "replacement reply"
      })
    }
    if (url.endsWith("/sessions/bridge-replacement/thread")) {
      return jsonResponse({
        id: "bridge-replacement",
        threadId: "thread-replacement",
        thread: { id: "thread-replacement", name: "Harness · Replacement", turns: [] }
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  await postCodexConversationMessage({
    repository,
    conversationId,
    content: "rebuild the lost thread",
    idempotencyKey: "replacement-message"
  })

  assert.deepEqual(sessionBodies, [
    { threadId: "thread-lost", name: "Harness · Replacement" },
    { name: "Harness · Replacement" }
  ])
  assert.equal(repository.getCodexSession(conversationId)?.codexThreadId, "thread-replacement")
  assert.equal(repository.getCodexSession(conversationId)?.replacementOfThreadId, "thread-lost")
})

test("marks a deleted native thread replacement-pending without deleting Harness history", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-pending-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-pending"
  const entry = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content: "keep this history",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "pending-history"
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-pending",
    codexThreadId: "thread-deleted",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const previousBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    if (previousBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = previousBridgeUrl
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith("/sessions/bridge-pending/events?after=0")) {
      return jsonResponse({
        id: "bridge-pending",
        threadId: "thread-deleted",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0
      })
    }
    if (url.endsWith("/sessions/bridge-pending/thread")) {
      return jsonResponse({ error: "thread not found" }, 404)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const state = await getCodexConversationState(repository, conversationId)

  assert.equal(state.session?.mappingState, "replacement_pending")
  assert.match(state.session?.syncWarning ?? "", /replacement/i)
  assert.equal(repository.listConversation(conversationId)[0]?.id, entry.entry.id)
})

test("does not project the shared Harness prompt back as a duplicate native user entry", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-synthetic-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-synthetic"
  const user = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content: "real Harness prompt",
    importance: "normal",
    status: "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "synthetic-user"
  })
  const response = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "agent",
    agentId: "codex",
    content: "Codex is working...",
    importance: "important",
    status: "queued",
    replyToId: user.entry.id,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "synthetic-user:response"
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-synthetic",
    codexThreadId: "thread-synthetic",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const previousBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    if (previousBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = previousBridgeUrl
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/sessions/bridge-synthetic/turns")) {
      return jsonResponse({
        id: "bridge-synthetic",
        threadId: "thread-synthetic",
        status: "running",
        turnStatus: "inProgress",
        cursor: 0,
        turn: { id: "turn-synthetic", status: "inProgress" }
      }, 202)
    }
    if (url.endsWith("/sessions/bridge-synthetic/events?after=0")) {
      return jsonResponse({
        id: "bridge-synthetic",
        threadId: "thread-synthetic",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0,
        finalText: "native Harness response"
      })
    }
    if (url.endsWith("/sessions/bridge-synthetic/thread")) {
      return jsonResponse({
        id: "bridge-synthetic",
        threadId: "thread-synthetic",
        thread: {
          id: "thread-synthetic",
          turns: [{
            id: "turn-synthetic",
            status: "completed",
            items: [
              {
                id: "item-native-user",
                type: "userMessage",
                content: [{ type: "text", text: "[shared Harness context] real Harness prompt" }]
              },
              {
                id: "item-native-agent",
                type: "agentMessage",
                text: "native Harness response",
                phase: "final_answer"
              },
              {
                id: "item-native-agent-final",
                type: "agentMessage",
                text: "native Harness response final",
                phase: "final_answer"
              }
            ]
          }]
        }
      })
    }
    throw new Error(`Unexpected fetch: ${url} ${String(init?.method ?? "GET")}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const result = await dispatchCodexConversationEntry({
    repository,
    conversationId,
    userEntryId: user.entry.id,
    responseEntryId: response.entry.id,
    pollIntervalMs: 1
  })

  assert.equal(result.status, "completed")
  assert.deepEqual(repository.listConversation(conversationId).map((entry) => entry.content), [
    "real Harness prompt",
    "native Harness response final"
  ])
  assert.equal(repository.listCodexSyncItems(conversationId).filter((item) => item.nativeTurnId === "turn-synthetic").length, 3)
})

test("reuses the Harness response when native agent items lack a mapped user turn", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-response-dedupe-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-response-dedupe"
  const user = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content: "Harness prompt",
    importance: "normal",
    status: "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "response-dedupe-user"
  })
  const response = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "agent",
    agentId: "codex",
    content: "Codex is working...",
    importance: "important",
    status: "queued",
    replyToId: user.entry.id,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "response-dedupe-user:response"
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-response-dedupe",
    codexThreadId: "thread-response-dedupe",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const previousBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    if (previousBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = previousBridgeUrl
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input, init) => {
    const url = String(input)
    if (url.endsWith("/sessions/bridge-response-dedupe/turns")) {
      return jsonResponse({
        id: "bridge-response-dedupe",
        threadId: "thread-response-dedupe",
        status: "running",
        turnStatus: "inProgress",
        cursor: 0,
        turn: { id: "turn-harness", status: "inProgress" }
      }, 202)
    }
    if (url.endsWith("/sessions/bridge-response-dedupe/events?after=0")) {
      return jsonResponse({
        id: "bridge-response-dedupe",
        threadId: "thread-response-dedupe",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0,
        finalText: "native response"
      })
    }
    if (url.endsWith("/sessions/bridge-response-dedupe/thread")) {
      return jsonResponse({
        id: "bridge-response-dedupe",
        threadId: "thread-response-dedupe",
        thread: {
          id: "thread-response-dedupe",
          turns: [{
            id: "turn-native",
            status: "completed",
            items: [
              { id: "item-native-agent", type: "agentMessage", text: "native response", phase: "final_answer" },
              { id: "item-native-agent-final", type: "agentMessage", text: "native response", phase: "final_answer" }
            ]
          }]
        }
      })
    }
    throw new Error(`Unexpected fetch: ${url} ${String(init?.method ?? "GET")}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  const result = await dispatchCodexConversationEntry({
    repository,
    conversationId,
    userEntryId: user.entry.id,
    responseEntryId: response.entry.id,
    pollIntervalMs: 1
  })

  assert.equal(result.status, "completed")
  const entries = repository.listConversation(conversationId)
  assert.deepEqual(entries.map((entry) => entry.content), ["Harness prompt", "native response"])
  assert.equal(entries[1]?.replyToId, user.entry.id)
})
