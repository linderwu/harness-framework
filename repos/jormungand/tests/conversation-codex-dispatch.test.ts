import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { getCodexConversationState } from "../lib/codex-conversation"
import { ConversationLifecycleService } from "../lib/conversation-lifecycle/service"
import { ConversationDispatcher } from "../lib/conversation-dispatcher"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

async function fixture(t: test.TestContext, suffix: string) {
  const dataDir = await mkdtemp(join(tmpdir(), `jormungand-codex-${suffix}-`))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { repository, lifecycle }
}

function installBridge(t: test.TestContext, handler: typeof globalThis.fetch) {
  const originalFetch = globalThis.fetch
  const originalBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  globalThis.fetch = handler
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = originalBridgeUrl
  })
}

test("the real dispatcher claims and settles queued Codex turns in order", async (t) => {
  const { repository, lifecycle } = await fixture(t, "dispatcher")
  const conversationId = "conversation:codex-dispatch"
  await lifecycle.openConversation({ conversationId, title: "Dispatcher" })
  const first = await lifecycle.submitTurn({ conversationId, targetAgent: "codex", content: "first prompt", idempotencyKey: "first" })
  const second = await lifecycle.submitTurn({ conversationId, targetAgent: "codex", content: "future prompt", idempotencyKey: "future" })
  const dispatched: string[] = []
  const dispatcher = new ConversationDispatcher(repository, async (input) => {
    dispatched.push(input.content)
    return { status: "completed", body: `${input.content} response` }
  })

  await dispatcher.drain(conversationId)

  assert.deepEqual(dispatched, ["first prompt", "future prompt"])
  assert.deepEqual(repository.listConversation(conversationId).map((entry) => [entry.id, entry.status]), [
    [first.userEntryId, "completed"], [first.responseEntryId, "completed"],
    [second.userEntryId, "completed"], [second.responseEntryId, "completed"]
  ])
})

test("terminal Codex polling settles a claimed turn once and preserves raw body", async (t) => {
  const { repository, lifecycle } = await fixture(t, "lifecycle-poll")
  const conversationId = "conversation:codex-lifecycle-poll"
  await lifecycle.openConversation({ conversationId, title: "Poll" })
  const submitted = await lifecycle.submitTurn({ conversationId, targetAgent: "codex", content: "lifecycle prompt", idempotencyKey: "poll" })
  const claim = await lifecycle.claimNextTurn({ conversationId, leaseOwner: "poll-worker", leaseDurationMs: 60_000 })
  assert.ok(claim && !("rejected" in claim))
  await repository.upsertCodexSession({ conversationId, bridgeSessionId: "bridge-poll", codexThreadId: "thread-poll", status: "running", turnStatus: "inProgress", cursor: 0 })
  const rawFinalText = "  raw Codex terminal body  \n"
  installBridge(t, async (input) => {
    if (String(input).endsWith("/sessions/bridge-poll/events?after=0")) return jsonResponse({ id: "bridge-poll", threadId: "thread-poll", status: "idle", turnStatus: "completed", cursor: 1, nextCursor: 1, finalText: rawFinalText, events: [] })
    if (String(input).endsWith("/sessions/bridge-poll/thread")) return jsonResponse({ id: "bridge-poll", threadId: "thread-poll", thread: { id: "thread-poll", turns: [] } })
    throw new Error(`Unexpected fetch: ${String(input)}`)
  })

  await getCodexConversationState(repository, conversationId, lifecycle)
  await getCodexConversationState(repository, conversationId, lifecycle)

  assert.equal(repository.getExecutionJob(submitted.jobId)?.status, "completed")
  assert.deepEqual(repository.listConversation(conversationId).map((entry) => [entry.status, entry.content]), [["completed", "lifecycle prompt"], ["completed", rawFinalText]])
})

test("native projection does not overwrite a settled Harness response", async (t) => {
  const { repository, lifecycle } = await fixture(t, "native-settlement")
  const conversationId = "conversation:codex-native-settlement"
  await lifecycle.openConversation({ conversationId, title: "Native settlement" })
  const submitted = await lifecycle.submitTurn({ conversationId, targetAgent: "codex", content: "prompt", idempotencyKey: "native" })
  await lifecycle.claimNextTurn({ conversationId, leaseOwner: "native-worker", leaseDurationMs: 60_000 })
  await repository.upsertCodexSession({ conversationId, bridgeSessionId: "bridge-native", codexThreadId: "thread-native", status: "running", turnStatus: "inProgress", cursor: 0 })
  installBridge(t, async (input) => {
    if (String(input).endsWith("/sessions/bridge-native/events?after=0")) return jsonResponse({ id: "bridge-native", threadId: "thread-native", status: "idle", turnStatus: "completed", cursor: 1, nextCursor: 1, finalText: "Harness final", events: [] })
    if (String(input).endsWith("/sessions/bridge-native/thread")) return jsonResponse({ id: "bridge-native", threadId: "thread-native", thread: { id: "thread-native", turns: [{ id: "native-only", status: "completed", items: [{ id: "native-agent", type: "agentMessage", text: "Native history", phase: "final_answer" }] }] } })
    throw new Error(`Unexpected fetch: ${String(input)}`)
  })

  await getCodexConversationState(repository, conversationId, lifecycle)

  assert.equal(repository.getConversationEntry(submitted.responseEntryId)?.content, "Harness final")
  assert.deepEqual(repository.listConversation(conversationId).map((entry) => entry.content), ["prompt", "Harness final", "Native history"])
})

test("terminal polling preserves the manager response role", async (t) => {
  const { repository, lifecycle } = await fixture(t, "manager")
  const conversationId = "conversation:codex-manager"
  await lifecycle.openConversation({ conversationId, title: "Manager" })
  await lifecycle.submitTurn({ conversationId, targetAgent: "codex", content: "manager prompt", idempotencyKey: "manager", responseRole: "manager" })
  await lifecycle.claimNextTurn({ conversationId, leaseOwner: "manager-worker", leaseDurationMs: 60_000 })
  await repository.upsertCodexSession({ conversationId, bridgeSessionId: "bridge-manager", codexThreadId: "thread-manager", status: "running", turnStatus: "inProgress", cursor: 0 })
  const rawFinalText = "  manager final  \n"
  installBridge(t, async (input) => {
    if (String(input).endsWith("/sessions/bridge-manager/events?after=0")) return jsonResponse({ id: "bridge-manager", threadId: "thread-manager", status: "idle", turnStatus: "completed", cursor: 1, nextCursor: 1, finalText: rawFinalText, events: [] })
    if (String(input).endsWith("/sessions/bridge-manager/thread")) return jsonResponse({ id: "bridge-manager", threadId: "thread-manager", thread: { id: "thread-manager", turns: [] } })
    throw new Error(`Unexpected fetch: ${String(input)}`)
  })

  await getCodexConversationState(repository, conversationId, lifecycle)
  assert.deepEqual(repository.listConversation(conversationId).map((entry) => [entry.role, entry.status, entry.content]), [["user", "completed", "manager prompt"], ["manager", "completed", rawFinalText]])
})
