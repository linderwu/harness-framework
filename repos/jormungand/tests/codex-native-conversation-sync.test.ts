import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { getCodexConversationState } from "../lib/codex-conversation"
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
