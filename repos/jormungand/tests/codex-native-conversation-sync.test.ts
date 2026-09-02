import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  controlCodexConversation,
  getCodexConversationState
} from "../lib/codex-conversation"
import { ConversationLifecycleService } from "../lib/conversation-lifecycle/service"
import { projectNativeThread } from "../lib/codex-thread-sync"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

function createLifecycleSpy(repository: ReturnType<typeof createHiveMemoryRepository>) {
  const service = new ConversationLifecycleService(repository) as unknown as {
    recordTurnProgress(input: unknown): Promise<unknown>
    settleTurn(input: unknown): Promise<unknown>
    reconcileProviderEntry(input: unknown): Promise<unknown>
    coalesceProviderEntries(input: unknown): Promise<void>
  }
  const calls = {
    recordTurnProgress: [] as unknown[],
    settleTurn: [] as unknown[],
    reconcileProviderEntry: [] as unknown[],
    coalesceProviderEntries: [] as unknown[]
  }
  return {
    calls,
    async recordTurnProgress(input: unknown) {
      calls.recordTurnProgress.push(input)
      return await service.recordTurnProgress(input)
    },
    async settleTurn(input: unknown) {
      calls.settleTurn.push(input)
      return await service.settleTurn(input)
    },
    async reconcileProviderEntry(input: unknown) {
      calls.reconcileProviderEntry.push(input)
      return await service.reconcileProviderEntry(input)
    },
    async coalesceProviderEntries(input: unknown) {
      calls.coalesceProviderEntries.push(input)
      await service.coalesceProviderEntries(input)
    }
  }
}

test("native reconciliation rejects an idempotency key already owned by another conversation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-idempotency-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  await lifecycle.openConversation({ conversationId: "conversation:native-owner", title: "Owner" })
  await lifecycle.openConversation({ conversationId: "conversation:native-other", title: "Other" })
  const first = await lifecycle.reconcileProviderEntry({
    conversationId: "conversation:native-owner",
    role: "user",
    content: "native prompt",
    status: "completed",
    idempotencyKey: "codex:shared-native-item"
  })

  await assert.rejects(
    lifecycle.reconcileProviderEntry({
      conversationId: "conversation:native-other",
      role: "user",
      content: "other native prompt",
      status: "completed",
      idempotencyKey: "codex:shared-native-item"
    }),
    /different conversation/
  )
  assert.equal(repository.getConversationEntry(first.id)?.workflowRunId, "conversation:native-owner")
  assert.deepEqual(repository.listConversation("conversation:native-other"), [])
})

test("provider reconciliation rejects invalid replacements and reply relationships without mutation", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-integrity-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  const conversationId = "conversation:native-integrity"
  const otherConversationId = "conversation:native-integrity-other"
  await lifecycle.openConversation({ conversationId, title: "Native integrity" })
  await lifecycle.openConversation({ conversationId: otherConversationId, title: "Other native integrity" })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const insertEntry = async (input: {
    conversationId: string
    role: "user" | "agent" | "manager"
    agentId: "codex" | "openclaw.rowlet"
    status: "running" | "completed"
    idempotencyKey: string
    replyToId?: string
  }) => (await repository.insertConversation({
    workflowRunId: input.conversationId,
    role: input.role,
    agentId: input.agentId,
    content: input.idempotencyKey,
    importance: input.role === "user" ? "normal" : "important",
    status: input.status,
    replyToId: input.replyToId,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: input.idempotencyKey
  })).entry
  const user = await insertEntry({
    conversationId,
    role: "user",
    agentId: "codex",
    status: "running",
    idempotencyKey: "integrity-user"
  })
  const otherUser = await insertEntry({
    conversationId,
    role: "user",
    agentId: "codex",
    status: "running",
    idempotencyKey: "integrity-other-user"
  })
  const crossConversationUser = await insertEntry({
    conversationId: otherConversationId,
    role: "user",
    agentId: "codex",
    status: "running",
    idempotencyKey: "integrity-cross-user"
  })
  const wrongRole = await insertEntry({
    conversationId,
    role: "manager",
    agentId: "codex",
    status: "running",
    idempotencyKey: "integrity-wrong-role",
    replyToId: user.id
  })
  const wrongAgent = await insertEntry({
    conversationId,
    role: "agent",
    agentId: "openclaw.rowlet",
    status: "running",
    idempotencyKey: "integrity-wrong-agent",
    replyToId: user.id
  })
  const mismatchedReply = await insertEntry({
    conversationId,
    role: "agent",
    agentId: "codex",
    status: "running",
    idempotencyKey: "integrity-mismatched-reply",
    replyToId: user.id
  })
  const terminalResponse = await insertEntry({
    conversationId,
    role: "agent",
    agentId: "codex",
    status: "completed",
    idempotencyKey: "integrity-terminal-response",
    replyToId: user.id
  })
  const invalidReplyTarget = await insertEntry({
    conversationId,
    role: "agent",
    agentId: "codex",
    status: "running",
    idempotencyKey: "integrity-agent-reply-target",
    replyToId: user.id
  })

  type ReconcileInput = Parameters<ConversationLifecycleService["reconcileProviderEntry"]>[0]
  const snapshot = () => ({
    entries: repository.listConversation(conversationId),
    otherEntries: repository.listConversation(otherConversationId)
  })
  const expectRejectedWithoutMutation = async (input: ReconcileInput) => {
    const before = snapshot()
    await assert.rejects(lifecycle.reconcileProviderEntry(input), /provider entry/i)
    assert.deepEqual(snapshot(), before)
  }
  const replacement = (input: Partial<ReconcileInput> & Pick<ReconcileInput, "idempotencyKey" | "replaceEntryId">): ReconcileInput => ({
    conversationId,
    role: "agent",
    content: "must not mutate",
    status: "completed",
    replyToId: user.id,
    ...input
  })

  await expectRejectedWithoutMutation(replacement({
    idempotencyKey: "provider-replace-user",
    replaceEntryId: user.id
  }))
  await expectRejectedWithoutMutation(replacement({
    idempotencyKey: "provider-replace-wrong-role",
    replaceEntryId: wrongRole.id
  }))
  await expectRejectedWithoutMutation(replacement({
    idempotencyKey: "provider-replace-wrong-agent",
    replaceEntryId: wrongAgent.id
  }))
  await expectRejectedWithoutMutation(replacement({
    idempotencyKey: "provider-replace-mismatched-reply",
    replaceEntryId: mismatchedReply.id,
    replyToId: otherUser.id
  }))
  await expectRejectedWithoutMutation(replacement({
    idempotencyKey: "provider-replace-cross-reply",
    replaceEntryId: mismatchedReply.id,
    replyToId: crossConversationUser.id
  }))
  await expectRejectedWithoutMutation(replacement({
    idempotencyKey: "provider-replace-terminal",
    replaceEntryId: terminalResponse.id
  }))
  await expectRejectedWithoutMutation(replacement({
    idempotencyKey: "provider-replace-status-regression",
    replaceEntryId: mismatchedReply.id,
    status: "queued"
  }))
  await expectRejectedWithoutMutation({
    conversationId,
    role: "user",
    content: "invalid imported user",
    status: "completed",
    idempotencyKey: "provider-user-with-reply",
    replyToId: user.id
  })
  await expectRejectedWithoutMutation({
    conversationId,
    role: "agent",
    content: "missing reply",
    status: "completed",
    idempotencyKey: "provider-agent-without-reply"
  })
  await expectRejectedWithoutMutation({
    conversationId,
    role: "agent",
    content: "cross-conversation reply",
    status: "completed",
    idempotencyKey: "provider-agent-cross-reply",
    replyToId: crossConversationUser.id
  })
  await expectRejectedWithoutMutation({
    conversationId,
    role: "agent",
    content: "non-user reply",
    status: "completed",
    idempotencyKey: "provider-agent-non-user-reply",
    replyToId: invalidReplyTarget.id
  })

  const imported = await lifecycle.reconcileProviderEntry({
    conversationId,
    role: "user",
    content: "immutable provider content",
    status: "completed",
    idempotencyKey: "provider-immutable-replay"
  })
  const storedBeforeReplay = repository.getConversationEntry(imported.id)
  const replayed = await lifecycle.reconcileProviderEntry({
    conversationId,
    role: "user",
    content: "changed replay content",
    status: "failed",
    idempotencyKey: "provider-immutable-replay"
  })
  assert.equal(replayed.id, imported.id)
  assert.deepEqual(repository.getConversationEntry(imported.id), storedBeforeReplay)
})

test("imports a Codex desktop turn from the native thread snapshot", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-sync-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = createLifecycleSpy(repository)
  const conversationId = "conversation:native-sync"
  await repository.createConversation({ id: conversationId, title: "Native sync" })
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

  const readState = getCodexConversationState as unknown as (
    ...args: unknown[]
  ) => Promise<Awaited<ReturnType<typeof getCodexConversationState>>>
  const state = await readState(repository, conversationId, lifecycle)

  assert.deepEqual(state.entries.map((entry) => entry.content), [
    "desktop message",
    "desktop reply"
  ])
  assert.equal(repository.listCodexSyncItems(conversationId).length, 2)
  assert.equal(lifecycle.calls.reconcileProviderEntry.length, 2)

  await readState(repository, conversationId, lifecycle)
  assert.equal(repository.listConversation(conversationId).length, 2)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 2)
  assert.equal(lifecycle.calls.reconcileProviderEntry.length, 2)
})

test("staged native snapshots retain their exact ledgered user parent", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-staged-parent-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  const conversationId = "conversation:native-staged-parent"
  await lifecycle.openConversation({ conversationId, title: "Staged native parent" })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-staged-parent",
    codexThreadId: "thread-staged-a",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const nativeUser = {
    id: "item-staged-user",
    type: "userMessage",
    content: [{ type: "text", text: "Native user from the first snapshot" }]
  }
  const nativeAgent = {
    id: "item-staged-agent",
    type: "agentMessage",
    text: "Native agent added by the second snapshot",
    phase: "final_answer"
  }
  const replacementAgent = {
    id: "item-replacement-agent",
    type: "agentMessage",
    text: "Replacement-thread agent item",
    phase: "final_answer"
  }
  let nativeThreadId = "thread-staged-a"
  let nativeItems: unknown[] = [nativeUser]
  const previousBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    if (previousBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = previousBridgeUrl
  })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.includes("/sessions/bridge-staged-parent/events?after=")) {
      return jsonResponse({
        id: "bridge-staged-parent",
        threadId: nativeThreadId,
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0
      })
    }
    if (url.endsWith("/sessions/bridge-staged-parent/thread")) {
      return jsonResponse({
        id: "bridge-staged-parent",
        threadId: nativeThreadId,
        status: "idle",
        turnStatus: "completed",
        thread: {
          id: nativeThreadId,
          turns: [{
            id: "turn-staged-x",
            status: "completed",
            items: nativeItems
          }]
        }
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  await getCodexConversationState(repository, conversationId, lifecycle)
  const originalNativeUser = repository.listConversation(conversationId)
    .find((entry) => entry.content === "Native user from the first snapshot")
  assert.ok(originalNativeUser)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 1)

  const unrelatedUser = await lifecycle.reconcileProviderEntry({
    conversationId,
    role: "user",
    content: "Later unrelated user",
    status: "completed",
    idempotencyKey: "staged-parent-unrelated-user"
  })
  nativeItems = [nativeUser, nativeAgent]

  await getCodexConversationState(repository, conversationId, lifecycle)
  const originalAgent = repository.listConversation(conversationId)
    .find((entry) => entry.content === "Native agent added by the second snapshot")
  assert.ok(originalAgent)
  assert.equal(originalAgent.replyToId, originalNativeUser.id)
  assert.notEqual(originalAgent.replyToId, unrelatedUser.id)
  assert.equal(repository.listConversation(conversationId).length, 3)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 2)

  await getCodexConversationState(repository, conversationId, lifecycle)
  assert.equal(repository.listConversation(conversationId).length, 3)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 2)

  nativeThreadId = "thread-staged-b"
  nativeItems = [replacementAgent]
  await getCodexConversationState(repository, conversationId, lifecycle)
  const replacementThreadAgent = repository.listConversation(conversationId)
    .find((entry) => entry.content === "Replacement-thread agent item")
  assert.ok(replacementThreadAgent)
  assert.equal(replacementThreadAgent.replyToId, unrelatedUser.id)
  assert.notEqual(replacementThreadAgent.replyToId, originalNativeUser.id)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 3)

  await getCodexConversationState(repository, conversationId, lifecycle)
  assert.equal(repository.listConversation(conversationId).length, 4)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 3)
})

test("native interrupted snapshot remains running progress without a terminal projection", () => {
  const projection = projectNativeThread({
    conversationId: "conversation:native-interrupted",
    nativeThreadId: "thread-native-interrupted",
    turns: [{
      id: "turn-native-interrupted",
      status: "interrupted",
      items: [
        { id: "native-user", type: "userMessage", content: [{ type: "text", text: "Pause me" }] },
        { id: "native-agent", type: "agentMessage", text: "Partial response" }
      ]
    }],
    harnessTurnIds: new Set(),
    ledgerKeys: new Set()
  })

  assert.equal(projection.terminalStatus, undefined)
  assert.deepEqual(projection.entries.map((entry) => entry.status), ["running", "running"])
  assert.deepEqual(
    projection.entries.map((entry) => entry.idempotencyKey),
    [
      "codex:thread-native-interrupted:turn-native-interrupted:native-user",
      "codex:thread-native-interrupted:turn-native-interrupted:native-agent"
    ]
  )
})

test("running Codex text records lifecycle port progress", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-progress-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = createLifecycleSpy(repository)
  const conversationId = "conversation:native-progress"
  await repository.createConversation({ id: conversationId, title: "Native progress" })
  const submitted = await new ConversationLifecycleService(repository).submitTurn({
    conversationId,
    targetAgent: "codex",
    content: "Show progress",
    idempotencyKey: "native-progress"
  })
  await new ConversationLifecycleService(repository).claimNextTurn({
    conversationId,
    leaseOwner: "native-progress-worker",
    leaseDurationMs: 60_000
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-progress",
    codexThreadId: "thread-progress",
    status: "running",
    turnStatus: "inProgress",
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
    if (url.endsWith("/sessions/bridge-progress/events?after=0")) {
      return jsonResponse({
        id: "bridge-progress",
        threadId: "thread-progress",
        status: "running",
        turnStatus: "inProgress",
        cursor: 1,
        events: [{ id: "progress-1", sequence: 1, createdAt: "2026-09-03T00:00:00.000Z", type: "message", message: "Codex is thinking" }],
        nextCursor: 1
      })
    }
    if (url.endsWith("/sessions/bridge-progress/thread")) {
      return jsonResponse({ id: "bridge-progress", threadId: "thread-progress", thread: { id: "thread-progress", turns: [] } })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  await getCodexConversationState(
    repository,
    conversationId,
    lifecycle as unknown as import("../lib/conversation-lifecycle/types").ConversationLifecyclePort
  )

  assert.deepEqual(lifecycle.calls.recordTurnProgress, [{
    conversationId,
    userEntryId: submitted.userEntryId,
    responseEntryId: submitted.responseEntryId,
    body: "Codex is thinking"
  }])
  assert.equal(repository.getConversationEntry(submitted.responseEntryId)?.content, "Codex is thinking")
})

test("lifecycle progress rejects stale and invalid aggregates without changing either entry", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-stale-progress-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  const conversationId = "conversation:native-stale-progress"
  const otherConversationId = "conversation:native-stale-progress-other"
  await lifecycle.openConversation({ conversationId, title: "Stale progress" })
  await lifecycle.openConversation({ conversationId: otherConversationId, title: "Other progress" })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const snapshot = (ids: string[]) => ids.map((id) => {
    const entry = repository.getConversationEntry(id)
    return entry && { id: entry.id, role: entry.role, status: entry.status, content: entry.content, replyToId: entry.replyToId }
  })
  const expectNoProgressMutation = async (input: {
    conversationId: string
    userEntryId: string
    responseEntryId: string
    body: string
  }) => {
    const before = snapshot([input.userEntryId, input.responseEntryId])
    await assert.rejects(lifecycle.recordTurnProgress(input), /progress/i)
    assert.deepEqual(snapshot([input.userEntryId, input.responseEntryId]), before)
  }

  const settled = await lifecycle.submitTurn({
    conversationId,
    targetAgent: "codex",
    content: "settle first",
    idempotencyKey: "settled-progress"
  })
  const settledClaim = await lifecycle.claimNextTurn({
    conversationId,
    leaseOwner: "settled-progress-worker",
    leaseDurationMs: 60_000
  })
  assert.ok(settledClaim && !("rejected" in settledClaim))
  if (!settledClaim || "rejected" in settledClaim) throw new Error("Expected settled progress claim")
  const finalBody = "  final body must remain exact  \n"
  await lifecycle.settleTurn({
    conversationId,
    userEntryId: settled.userEntryId,
    responseEntryId: settled.responseEntryId,
    jobId: settled.jobId,
    idempotencyKey: settledClaim.idempotencyKey,
    leaseOwner: settledClaim.leaseOwner,
    outcome: { kind: "completed", body: finalBody, deliveryState: "confirmed" }
  })
  await expectNoProgressMutation({
    conversationId,
    userEntryId: settled.userEntryId,
    responseEntryId: settled.responseEntryId,
    body: "stale provider progress"
  })

  const active = await lifecycle.submitTurn({
    conversationId,
    targetAgent: "codex",
    content: "active turn",
    idempotencyKey: "active-progress"
  })
  const otherActive = await lifecycle.submitTurn({
    conversationId: otherConversationId,
    targetAgent: "codex",
    content: "other active turn",
    idempotencyKey: "other-active-progress"
  })
  await lifecycle.claimNextTurn({ conversationId, leaseOwner: "active-progress-worker", leaseDurationMs: 60_000 })
  await lifecycle.claimNextTurn({ conversationId: otherConversationId, leaseOwner: "other-progress-worker", leaseDurationMs: 60_000 })
  await expectNoProgressMutation({
    conversationId,
    userEntryId: active.userEntryId,
    responseEntryId: otherActive.responseEntryId,
    body: "cross conversation"
  })

  const queued = await lifecycle.submitTurn({
    conversationId,
    targetAgent: "codex",
    content: "queued turn",
    idempotencyKey: "queued-progress"
  })
  await expectNoProgressMutation({
    conversationId,
    userEntryId: queued.userEntryId,
    responseEntryId: queued.responseEntryId,
    body: "must not claim queued"
  })

  const wrongUser = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "agent",
    agentId: "codex",
    content: "wrong user role",
    importance: "important",
    status: "running",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "wrong-progress-user"
  })
  const wrongResponse = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "agent",
    agentId: "codex",
    content: "wrong reply target",
    importance: "important",
    status: "running",
    replyToId: active.userEntryId,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "wrong-progress-response"
  })
  await expectNoProgressMutation({
    conversationId,
    userEntryId: wrongUser.entry.id,
    responseEntryId: wrongResponse.entry.id,
    body: "wrong role and reply"
  })

  const terminalUser = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content: "terminal user",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "terminal-progress-user"
  })
  const runningResponse = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "manager",
    agentId: "codex",
    content: "manager must stay running",
    importance: "important",
    status: "running",
    replyToId: terminalUser.entry.id,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "terminal-progress-response"
  })
  await expectNoProgressMutation({
    conversationId,
    userEntryId: terminalUser.entry.id,
    responseEntryId: runningResponse.entry.id,
    body: "must not reopen terminal user"
  })
})

test("Pause and Continue preserve a claimed application Turn until the same Turn completes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-pause-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-pause"
  await repository.createConversation({ id: conversationId, title: "Native pause" })
  const submitted = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "Keep this Turn running through Pause.",
    idempotencyKey: "native-pause",
    responseRole: "agent"
  })
  const claimed = await repository.claimNextConversationTurn({
    conversationId,
    leaseOwner: "native-pause-worker",
    leaseDurationMs: 60_000
  })
  assert.ok(claimed && !("rejected" in claimed))
  if (!claimed || "rejected" in claimed) throw new Error("Expected claimed Turn")
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-native-pause",
    codexThreadId: "thread-native-pause",
    status: "running",
    turnStatus: "inProgress",
    cursor: 0
  })
  const previousBridgeUrl = process.env.CODEX_BRIDGE_URL
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  let state: { status: string; turnStatus: string; cursor: number } = {
    status: "paused",
    turnStatus: "interrupted",
    cursor: 1
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (input) => {
    const url = String(input)
    if (url.endsWith("/interrupt") || url.endsWith("/resume")) return jsonResponse({ ok: true })
    if (url.includes("/events?after=")) {
      return jsonResponse({
        id: "bridge-native-pause",
        threadId: "thread-native-pause",
        ...state,
        events: [],
        nextCursor: state.cursor
      })
    }
    if (url.endsWith("/thread")) return jsonResponse({
      id: "bridge-native-pause",
      threadId: "thread-native-pause",
      thread: { id: "thread-native-pause", turns: [] }
    })
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(async () => {
    globalThis.fetch = originalFetch
    if (previousBridgeUrl === undefined) delete process.env.CODEX_BRIDGE_URL
    else process.env.CODEX_BRIDGE_URL = previousBridgeUrl
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  await controlCodexConversation(repository, "interrupt", conversationId)
  assert.deepEqual(repository.listConversation(conversationId).map((entry) => entry.status), ["running", "running"])
  assert.equal(repository.getExecutionJob(submitted.jobId)?.status, "running")
  assert.deepEqual(repository.getCodexSession(conversationId), {
    ...repository.getCodexSession(conversationId),
    status: "paused",
    turnStatus: "interrupted"
  })

  state = { status: "running", turnStatus: "inProgress", cursor: 2 }
  await controlCodexConversation(repository, "resume", conversationId)
  assert.deepEqual(repository.listConversation(conversationId).map((entry) => entry.status), ["running", "running"])
  assert.equal(repository.getExecutionJob(submitted.jobId)?.status, "running")

  state = { status: "idle", turnStatus: "completed", cursor: 3 }
  await getCodexConversationState(repository, conversationId, new ConversationLifecycleService(repository))
  assert.equal(repository.getExecutionJob(submitted.jobId)?.status, "completed")
  assert.deepEqual(repository.listConversation(conversationId).map((entry) => entry.status), ["completed", "completed"])
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

  const state = await getCodexConversationState(repository, conversationId, new ConversationLifecycleService(repository))

  assert.deepEqual(state.entries.map((entry) => entry.content), ["Harness prompt"])
  assert.equal(state.entries.filter((entry) => entry.role === "user").length, 1)
})

test("old-thread Harness ledger turns do not suppress replacement-thread native history", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-replacement-harness-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  const conversationId = "conversation:native-replacement-harness"
  await lifecycle.openConversation({ conversationId, title: "Replacement Harness turn" })
  const oldHarnessUser = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content: "Old Harness prompt",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "replacement-old-harness-user"
  })
  const currentHarnessUser = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content: "Current Harness prompt",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "replacement-current-harness-user"
  })
  await repository.recordCodexSyncItem({
    conversationId,
    nativeThreadId: "thread-old",
    nativeTurnId: "turn-1",
    nativeItemId: "item-old-harness-user",
    source: "harness",
    kind: "userMessage",
    conversationEntryId: oldHarnessUser.entry.id,
    contentHash: "Old Harness prompt"
  })
  await repository.recordCodexSyncItem({
    conversationId,
    nativeThreadId: "thread-new",
    nativeTurnId: "turn-current-harness",
    nativeItemId: "item-current-harness-user",
    source: "harness",
    kind: "userMessage",
    conversationEntryId: currentHarnessUser.entry.id,
    contentHash: "Current Harness prompt"
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-replacement-harness",
    codexThreadId: "thread-new",
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
    if (url.includes("/sessions/bridge-replacement-harness/events?after=")) {
      return jsonResponse({
        id: "bridge-replacement-harness",
        threadId: "thread-new",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0
      })
    }
    if (url.endsWith("/sessions/bridge-replacement-harness/thread")) {
      return jsonResponse({
        id: "bridge-replacement-harness",
        threadId: "thread-new",
        thread: {
          id: "thread-new",
          turns: [
            {
              id: "turn-1",
              status: "completed",
              items: [
                {
                  id: "item-replacement-native-user",
                  type: "userMessage",
                  content: [{ type: "text", text: "Replacement native prompt" }]
                },
                {
                  id: "item-replacement-native-agent",
                  type: "agentMessage",
                  text: "Replacement native reply",
                  phase: "final_answer"
                }
              ]
            },
            {
              id: "turn-current-harness",
              status: "completed",
              items: [
                {
                  id: "item-current-harness-user",
                  type: "userMessage",
                  content: [{ type: "text", text: "Current Harness prompt" }]
                },
                {
                  id: "item-current-harness-agent",
                  type: "agentMessage",
                  text: "Current Harness reply must stay excluded",
                  phase: "final_answer"
                }
              ]
            }
          ]
        }
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  await getCodexConversationState(repository, conversationId, lifecycle)
  const entries = repository.listConversation(conversationId)
  const replacementNativeUser = entries.find((entry) => entry.content === "Replacement native prompt")
  const replacementNativeAgent = entries.find((entry) => entry.content === "Replacement native reply")
  assert.ok(replacementNativeUser)
  assert.ok(replacementNativeAgent)
  assert.equal(replacementNativeAgent.replyToId, replacementNativeUser.id)
  assert.equal(entries.some((entry) => entry.content === "Current Harness reply must stay excluded"), false)
  assert.equal(entries.length, 4)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 4)

  await getCodexConversationState(repository, conversationId, lifecycle)
  assert.equal(repository.listConversation(conversationId).length, 4)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 4)
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

  await getCodexConversationState(
    repository,
    conversationId,
    new ConversationLifecycleService(repository)
  )

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

  await getCodexConversationState(
    repository,
    conversationId,
    new ConversationLifecycleService(repository)
  )

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

  const state = await getCodexConversationState(repository, conversationId, new ConversationLifecycleService(repository))

  assert.equal(state.session?.mappingState, "replacement_pending")
  assert.match(state.session?.syncWarning ?? "", /replacement/i)
  assert.equal(repository.listConversation(conversationId)[0]?.id, entry.entry.id)
})

test("reconciles unledgered native items through the lifecycle port", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-synthetic-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-synthetic"
  await repository.createConversation({ id: conversationId, title: "Native synthetic" })
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
  await repository.insertConversation({
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

  await getCodexConversationState(
    repository,
    conversationId,
    new ConversationLifecycleService(repository)
  )

  assert.deepEqual(repository.listConversation(conversationId).map((entry) => entry.content), [
    "real Harness prompt",
    "Codex is working...",
    "[shared Harness context] real Harness prompt",
    "native Harness response",
    "native Harness response final"
  ])
  assert.equal(repository.listCodexSyncItems(conversationId).filter((item) => item.nativeTurnId === "turn-synthetic").length, 3)
})

test("defers agent-only native completion while its lifecycle Turn has an active lease", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-active-race-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  const conversationId = "conversation:native-active-race"
  await lifecycle.openConversation({ conversationId, title: "Native active race" })
  const submitted = await lifecycle.submitTurn({
    conversationId,
    targetAgent: "codex",
    content: "Keep lifecycle ownership while native history catches up.",
    idempotencyKey: "native-active-race"
  })
  const claimed = await lifecycle.claimNextTurn({
    conversationId,
    leaseOwner: "native-active-race-worker",
    leaseDurationMs: 60_000
  })
  assert.ok(claimed && !("rejected" in claimed))
  if (!claimed || "rejected" in claimed) throw new Error("Expected active native-race claim")
  assert.equal(claimed.userEntryId, submitted.userEntryId)
  assert.equal(claimed.responseEntryId, submitted.responseEntryId)
  assert.equal(claimed.jobId, submitted.jobId)
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-active-race",
    codexThreadId: "thread-active-race",
    status: "running",
    turnStatus: "inProgress",
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
    if (url.includes("/sessions/bridge-active-race/events?after=")) {
      return jsonResponse({
        id: "bridge-active-race",
        threadId: "thread-active-race",
        status: "running",
        turnStatus: "inProgress",
        cursor: 1,
        events: [{
          id: "active-race-progress",
          sequence: 1,
          createdAt: "2026-09-03T00:00:00.000Z",
          type: "message",
          message: "Bridge still running"
        }],
        nextCursor: 1
      })
    }
    if (url.endsWith("/sessions/bridge-active-race/thread")) {
      return jsonResponse({
        id: "bridge-active-race",
        threadId: "thread-active-race",
        thread: {
          id: "thread-active-race",
          turns: [{
            id: "turn-native-active-race",
            status: "completed",
            items: [{
              id: "item-native-active-race-agent",
              type: "agentMessage",
              text: "native final without mapped user",
              phase: "final_answer"
            }]
          }]
        }
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  await getCodexConversationState(repository, conversationId, lifecycle)

  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => ({ status: entry.status, content: entry.content })),
    [
      { status: "running", content: "Keep lifecycle ownership while native history catches up." },
      { status: "running", content: "Bridge still running" }
    ]
  )
  assert.equal(repository.getExecutionJob(submitted.jobId)?.status, "running")
  assert.deepEqual(repository.listCodexSyncItems(conversationId), [])

  const stopped = await lifecycle.stopTurn(conversationId)
  assert.ok(stopped?.applied)
  assert.equal(repository.getExecutionJob(submitted.jobId)?.status, "canceled")
  assert.deepEqual(repository.listConversation(conversationId).map((entry) => entry.status), ["interrupted", "interrupted"])

  await getCodexConversationState(repository, conversationId, lifecycle)
  const reconciledEntries = repository.listConversation(conversationId)
  assert.equal(reconciledEntries.length, 3)
  assert.equal(reconciledEntries[1]?.content, "Bridge still running")
  assert.deepEqual(
    reconciledEntries.slice(0, 2).map((entry) => entry.status),
    ["interrupted", "interrupted"]
  )
  assert.deepEqual(
    reconciledEntries[2] && {
      content: reconciledEntries[2].content,
      status: reconciledEntries[2].status,
      replyToId: reconciledEntries[2].replyToId
    },
    {
      content: "native final without mapped user",
      status: "completed",
      replyToId: submitted.userEntryId
    }
  )
  assert.equal(repository.listCodexSyncItems(conversationId).length, 1)

  await getCodexConversationState(repository, conversationId, lifecycle)
  assert.equal(repository.listConversation(conversationId).length, 3)
  assert.equal(repository.listCodexSyncItems(conversationId).length, 1)
})

test("reuses a pending Harness response when native agent items lack a mapped user turn", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-response-dedupe-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:native-response-dedupe"
  await repository.createConversation({ id: conversationId, title: "Native response dedupe" })
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
  await repository.insertConversation({
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

  await getCodexConversationState(
    repository,
    conversationId,
    new ConversationLifecycleService(repository)
  )

  const entries = repository.listConversation(conversationId)
  assert.deepEqual(
    entries.map((entry) => entry.content).sort(),
    ["Harness prompt", "native response"].sort()
  )
  assert.equal(entries.find((entry) => entry.content === "native response")?.replyToId, user.entry.id)
})

test("coalesces a native response projected before its Harness placeholder", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-native-codex-coalesce-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const lifecycle = new ConversationLifecycleService(repository)
  const conversationId = "conversation:native-coalesce"
  const user = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content: "Harness prompt",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "coalesce-user"
  })
  const response = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "agent",
    agentId: "codex",
    content: "native response",
    importance: "important",
    status: "completed",
    replyToId: user.entry.id,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "coalesce-user:response"
  })
  const duplicate = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "agent",
    agentId: "codex",
    content: "native response",
    importance: "important",
    status: "completed",
    replyToId: user.entry.id,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "codex:thread-coalesce:turn-coalesce:item-native-agent"
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-coalesce",
    codexThreadId: "thread-coalesce",
    status: "idle",
    turnStatus: "completed",
    cursor: 0
  })
  await repository.recordCodexSyncItem({
    conversationId,
    nativeThreadId: "thread-coalesce",
    nativeTurnId: "turn-coalesce",
    nativeItemId: "item-native-agent",
    source: "codex",
    kind: "agentMessage",
    conversationEntryId: duplicate.entry.id,
    contentHash: "native response"
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
    if (url.endsWith("/sessions/bridge-coalesce/events?after=0")) {
      return jsonResponse({
        id: "bridge-coalesce",
        threadId: "thread-coalesce",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0,
        finalText: "native response"
      })
    }
    if (url.endsWith("/sessions/bridge-coalesce/thread")) {
      return jsonResponse({
        id: "bridge-coalesce",
        threadId: "thread-coalesce",
        thread: {
          id: "thread-coalesce",
          turns: [{
            id: "turn-coalesce",
            status: "completed",
            items: [{
              id: "item-native-agent",
              type: "agentMessage",
              text: "native response",
              phase: "final_answer"
            }]
          }]
        }
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }
  t.after(() => {
    globalThis.fetch = originalFetch
  })

  await getCodexConversationState(repository, conversationId, lifecycle)

  const entries = repository.listConversation(conversationId)
  assert.deepEqual(
    entries.map((entry) => entry.id).sort(),
    [user.entry.id, response.entry.id].sort()
  )
  assert.equal(repository.listCodexSyncItems(conversationId)[0]?.conversationEntryId, response.entry.id)
})
