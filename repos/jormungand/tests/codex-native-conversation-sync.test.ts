import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
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
