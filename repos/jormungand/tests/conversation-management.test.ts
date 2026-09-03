import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { ConversationLifecycleService } from "../lib/conversation-lifecycle/service"
import { CodexConversationError } from "../lib/codex-conversation"
import { legacyConversationId } from "../lib/conversation-identity"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

type ConversationState = "active" | "archived"

interface ConversationMetadata {
  conversationId: string
  title: string
  state: ConversationState
  selectedModelId?: string
  selectedReasoningIntensity?: "low" | "medium" | "high" | "auto"
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

interface ConversationSummary {
  conversationId: string
  title: string
  state: ConversationState
  messageCount: number
  latestMessageAt?: string
  latestMessage?: string
}

type OpenClawRuntimeSessionState = "pending" | "active" | "delivery_unknown"

interface OpenClawRuntimeSession {
  conversationId: string
  agentId: "openclaw.rowlet" | "openclaw.gengar"
  provider: "openclaw"
  sessionNamespace: "harness-direct-v1"
  state: OpenClawRuntimeSessionState
  sessionKeyFingerprint: string
  bootstrapDelivered: boolean
  lastDeliveredEntryId?: string
  createdAt: string
  updatedAt: string
}

type ConversationManagementRepository = ReturnType<typeof createHiveMemoryRepository> & {
  createConversation(input: { id: string; title: string }): Promise<ConversationMetadata>
  getConversationMetadata(id: string): ConversationMetadata | undefined
  listConversationSummaries(input?: { includeArchived?: boolean }): ConversationSummary[]
  updateConversationModel(input: { id: string; selectedModelId?: string | null }): Promise<ConversationMetadata>
  updateConversationProfile(input: { id: string; selectedModelId?: string | null; selectedReasoningIntensity?: "low" | "medium" | "high" | "auto" | null }): Promise<ConversationMetadata>
  renameConversation(id: string, title: string): Promise<ConversationMetadata>
  setConversationState(id: string, state: ConversationState): Promise<ConversationMetadata>
  isConversationRunning(id: string): boolean
  deleteConversation(id: string): Promise<void>
  getOpenClawRuntimeSession(
    conversationId: string,
    agentId: OpenClawRuntimeSession["agentId"]
  ): OpenClawRuntimeSession | undefined
  upsertOpenClawRuntimeSession(input: {
    conversationId: string
    agentId: OpenClawRuntimeSession["agentId"]
    sessionNamespace: "harness-direct-v1"
    state: OpenClawRuntimeSessionState
    sessionKeyFingerprint: string
    bootstrapDelivered: boolean
    lastDeliveredEntryId?: string
  }): Promise<OpenClawRuntimeSession | undefined>
}

interface ConversationManagementService {
  createConversation(input?: {
    conversationId?: string
    title?: string
  }): Promise<ConversationMetadata>
  listConversations(input?: {
    includeArchived?: boolean
  }): ConversationSummary[]
  updateConversation(input: {
    conversationId: string
    title?: unknown
    state?: unknown
    selectedModelId?: unknown
    selectedReasoningIntensity?: unknown
  }): Promise<ConversationSummary>
  deleteConversation(input: {
    conversationId: string
    confirm?: unknown
  }): Promise<void>
}

async function createRepositoryFixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-management-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return createHiveMemoryRepository(database) as ConversationManagementRepository
}

async function createConversationFixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-management-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database) as ConversationManagementRepository
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { database, repository }
}

async function loadConversationManagementModule() {
  return await import("../lib/conversation-management") as {
    createConversationManagementService?: (dependencies: {
      repository: ConversationManagementRepository
      lifecycle: ConversationManagementLifecycle
      stopSession: (conversationId: string) => Promise<void>
      renameNativeThread?: (conversationId: string, title: string) => Promise<void>
      setNativeThreadState?: (conversationId: string, state: ConversationState) => Promise<void>
      deleteNativeThread?: (conversationId: string) => Promise<void>
    }) => ConversationManagementService
  }
}

interface ConversationManagementLifecycle {
  createConversation(input: { conversationId: string; title: string }): Promise<ConversationMetadata>
  validateConversationTitle(value: unknown): string
  updateConversationSettings(input: {
    conversationId: string
    selectedModelId?: string | null
    selectedReasoningIntensity?: ConversationMetadata["selectedReasoningIntensity"] | null
  }): Promise<ConversationMetadata>
  renameConversation(input: { conversationId: string; title: string }): Promise<ConversationMetadata>
  setConversationState(input: {
    conversationId: string
    state: ConversationState
  }): Promise<ConversationMetadata>
  validateConversationState(value: unknown): ConversationState
  cancelPendingTurns(conversationId: string): Promise<number>
  deleteConversation(input: { conversationId: string }): Promise<void>
}

test("conversation metadata can be created, listed, renamed, archived, and restored", async (t) => {
  const repository = await createRepositoryFixture(t)
  const conversationId = "conversation:11111111-1111-4111-8111-111111111111"

  assert.equal(typeof repository.createConversation, "function")
  assert.equal(typeof repository.listConversationSummaries, "function")
  assert.equal(typeof repository.renameConversation, "function")
  assert.equal(typeof repository.setConversationState, "function")
  assert.equal(typeof repository.getConversationMetadata, "function")

  const created = await repository.createConversation({
    id: conversationId,
    title: "  Fresh   planning thread  "
  })
  assert.equal(created.conversationId, conversationId)
  assert.equal(created.title, "Fresh planning thread")
  assert.equal(created.state, "active")
  assert.equal(created.archivedAt, undefined)

  const initialSummaries = repository.listConversationSummaries()
  assert.deepEqual(initialSummaries, [
    {
      conversationId,
      title: "Fresh planning thread",
      state: "active",
      messageCount: 0,
      latestMessageAt: undefined,
      latestMessage: undefined
    }
  ])

  await delay(10)
  const firstInsert = await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    content: "First user message becomes the latest message.",
    importance: "normal",
    status: "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-management:first-user"
  })
  const metadataAfterInsert = repository.getConversationMetadata(conversationId)
  assert.ok(metadataAfterInsert)
  assert.equal(metadataAfterInsert.updatedAt >= created.updatedAt, true)
  assert.equal(firstInsert.inserted, true)
  assert.equal(repository.listConversationSummaries()[0]?.messageCount, 1)
  assert.equal(repository.listConversationSummaries()[0]?.latestMessage, "First user message becomes the latest message.")

  await delay(10)
  const renamed = await repository.renameConversation(conversationId, "  Renamed   conversation title  ")
  assert.equal(renamed.title, "Renamed conversation title")
  assert.equal(repository.listConversationSummaries()[0]?.title, "Renamed conversation title")

  await delay(10)
  const archived = await repository.setConversationState(conversationId, "archived")
  assert.equal(archived.state, "archived")
  assert.ok(archived.archivedAt)
  assert.deepEqual(repository.listConversationSummaries(), [])
  assert.equal(repository.listConversationSummaries({ includeArchived: true })[0]?.conversationId, conversationId)

  await delay(10)
  const restored = await repository.setConversationState(conversationId, "active")
  assert.equal(restored.state, "active")
  assert.equal(restored.archivedAt, undefined)
  assert.equal(repository.listConversationSummaries()[0]?.conversationId, conversationId)
})

test("conversation model selection persists, preserves metadata state, and clears on empty values", async (t) => {
  const repository = await createRepositoryFixture(t)
  const conversationId = "conversation:12121212-1212-4121-8121-121212121212"

  await repository.createConversation({ id: conversationId, title: "Keep this title" })
  const beforeUpdate = repository.getConversationMetadata(conversationId)
  assert.ok(beforeUpdate)

  const selected = await repository.updateConversationModel({
    id: conversationId,
    selectedModelId: "gpt-5.6-sol"
  })
  assert.equal(selected.selectedModelId, "gpt-5.6-sol")
  assert.equal(selected.title, beforeUpdate.title)
  assert.equal(selected.state, beforeUpdate.state)

  const clearedByEmpty = await repository.updateConversationModel({
    id: conversationId,
    selectedModelId: ""
  })
  assert.equal(clearedByEmpty.selectedModelId, undefined)
  assert.equal(clearedByEmpty.title, beforeUpdate.title)
  assert.equal(clearedByEmpty.state, beforeUpdate.state)

  const clearedByNull = await repository.updateConversationModel({
    id: conversationId,
    selectedModelId: null
  })
  assert.equal(clearedByNull.selectedModelId, undefined)

  const profiled = await repository.updateConversationProfile({
    id: conversationId,
    selectedReasoningIntensity: "high"
  })
  assert.equal(profiled.selectedReasoningIntensity, "high")
  assert.equal(profiled.selectedModelId, undefined)
})

test("conversation running state follows Codex session status and turn status", async (t) => {
  const repository = await createRepositoryFixture(t)
  const conversationId = "conversation:22222222-2222-4222-8222-222222222222"

  assert.equal(typeof repository.isConversationRunning, "function")
  await repository.createConversation({ id: conversationId, title: "Running state" })
  assert.equal(repository.isConversationRunning(conversationId), false)

  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-1",
    codexThreadId: "thread-1",
    status: "idle",
    turnStatus: "completed"
  })
  assert.equal(repository.isConversationRunning(conversationId), false)

  await repository.updateCodexSession({
    conversationId,
    status: "running",
    turnStatus: "completed"
  })
  assert.equal(repository.isConversationRunning(conversationId), true)

  await repository.updateCodexSession({
    conversationId,
    status: "idle",
    turnStatus: "inProgress"
  })
  assert.equal(repository.isConversationRunning(conversationId), true)

  await repository.updateCodexSession({
    conversationId,
    status: "paused",
    turnStatus: "interrupted"
  })
  assert.equal(repository.isConversationRunning(conversationId), false)
})

test("conversation deletion removes unbound metadata, entries, and sessions while rejecting bound identities", async (t) => {
  const repository = await createRepositoryFixture(t)
  const conversationId = "conversation:33333333-3333-4333-8333-333333333333"

  assert.equal(typeof repository.deleteConversation, "function")
  assert.equal(typeof repository.upsertOpenClawRuntimeSession, "function")
  assert.equal(typeof repository.getOpenClawRuntimeSession, "function")
  await repository.createConversation({ id: conversationId, title: "Disposable thread" })
  await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    content: "Delete me.",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-management:delete"
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-delete",
    codexThreadId: "thread-delete",
    status: "running",
    turnStatus: "inProgress"
  })
  await repository.upsertOpenClawRuntimeSession({
    conversationId,
    agentId: "openclaw.rowlet",
    sessionNamespace: "harness-direct-v1",
    state: "active",
    sessionKeyFingerprint: "fingerprint-delete",
    bootstrapDelivered: true,
    lastDeliveredEntryId: "entry-delete-1"
  })

  await repository.deleteConversation(conversationId)
  assert.equal(repository.getConversationMetadata(conversationId), undefined)
  assert.deepEqual(repository.listConversation(conversationId), [])
  assert.equal(repository.getCodexSession(conversationId), undefined)
  assert.equal(
    repository.getOpenClawRuntimeSession(conversationId, "openclaw.rowlet"),
    undefined
  )

  await repository.insertConversation({
    workflowRunId: "run-bound-1",
    role: "user",
    content: "Bound workflow data must stay intact.",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-management:bound"
  })
  await repository.upsertCodexSession({
    conversationId: "run-bound-1",
    bridgeSessionId: "bridge-bound",
    codexThreadId: "thread-bound",
    status: "running",
    turnStatus: "inProgress"
  })

  await assert.rejects(
    repository.deleteConversation("run-bound-1"),
    /conversation:\*/i
  )
  await assert.rejects(
    repository.deleteConversation(legacyConversationId),
    /legacy/i
  )
  assert.equal(repository.listConversation("run-bound-1").length, 1)
  assert.ok(repository.getCodexSession("run-bound-1"))
})

test("conversation metadata mutations roll back when the metadata timestamp refresh fails", async (t) => {
  const { database, repository } = await createConversationFixture(t)
  const insertConversationId = "conversation:44444444-4444-4444-8444-444444444444"

  database.write((connection) => {
    connection.prepare(`
      CREATE TRIGGER fail_insert_metadata_touch
      BEFORE UPDATE ON conversations
      WHEN OLD.id = '${insertConversationId}'
      BEGIN
        SELECT RAISE(FAIL, 'metadata touch failed');
      END;
    `).run()
  })

  await assert.rejects(
    repository.insertConversation({
      workflowRunId: insertConversationId,
      role: "user",
      content: "Atomic insert must not leak conversation rows.",
      importance: "normal",
      status: "queued",
      artifactIds: [],
      memoryIds: [],
      idempotencyKey: "conversation-management:atomic-insert"
    }),
    /metadata touch failed/i
  )
  assert.equal(repository.getConversationMetadata(insertConversationId), undefined)
  assert.deepEqual(repository.listConversation(insertConversationId), [])

  await database.write((connection) => {
    connection.prepare("DROP TRIGGER fail_insert_metadata_touch").run()
  })

  const updateConversationId = "conversation:55555555-5555-4555-8555-555555555555"
  await repository.createConversation({ id: updateConversationId, title: "Stable title" })
  const inserted = await repository.insertConversation({
    workflowRunId: updateConversationId,
    role: "user",
    content: "Original content",
    importance: "normal",
    status: "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-management:atomic-update"
  })
  const metadataBeforeUpdate = repository.getConversationMetadata(updateConversationId)
  assert.ok(metadataBeforeUpdate)

  await database.write((connection) => {
    connection.prepare(`
      CREATE TRIGGER fail_update_metadata_touch
      BEFORE UPDATE ON conversations
      WHEN OLD.id = '${updateConversationId}'
      BEGIN
        SELECT RAISE(FAIL, 'metadata touch failed');
      END;
    `).run()
  })

  await assert.rejects(
    repository.updateConversation({
      id: inserted.entry.id,
      content: "Changed content",
      status: "running"
    }),
    /metadata touch failed/i
  )

  const entryAfterFailure = repository.getConversationEntry(inserted.entry.id)
  assert.ok(entryAfterFailure)
  assert.equal(entryAfterFailure.content, "Original content")
  assert.equal(entryAfterFailure.status, "queued")
  assert.deepEqual(repository.getConversationMetadata(updateConversationId), metadataBeforeUpdate)
})

test("conversation move rolls back when metadata move cleanup fails", async (t) => {
  const { database, repository } = await createConversationFixture(t)
  const sourceConversationId = "conversation:66666666-6666-4666-8666-666666666666"
  const targetWorkflowRunId = "run-bound-move"

  await repository.createConversation({
    id: sourceConversationId,
    title: "Move source"
  })
  const inserted = await repository.insertConversation({
    workflowRunId: sourceConversationId,
    role: "user",
    content: "This move must stay atomic.",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-management:atomic-move"
  })
  const sourceMetadataBeforeMove = repository.getConversationMetadata(sourceConversationId)
  assert.ok(sourceMetadataBeforeMove)

  await database.write((connection) => {
    connection.prepare(`
      CREATE TRIGGER fail_move_metadata_delete
      BEFORE DELETE ON conversations
      WHEN OLD.id = '${sourceConversationId}'
      BEGIN
        SELECT RAISE(FAIL, 'metadata move failed');
      END;
    `).run()
  })

  await assert.rejects(
    repository.moveConversation(sourceConversationId, targetWorkflowRunId),
    /metadata move failed/i
  )

  const sourceEntries = repository.listConversation(sourceConversationId)
  const targetEntries = repository.listConversation(targetWorkflowRunId)
  assert.equal(sourceEntries.length, 1)
  assert.equal(sourceEntries[0]?.id, inserted.entry.id)
  assert.deepEqual(targetEntries, [])
  assert.deepEqual(repository.getConversationMetadata(sourceConversationId), sourceMetadataBeforeMove)
  assert.equal(repository.getConversationMetadata(targetWorkflowRunId), undefined)
})

test("conversation management service validates updates, allows running state changes, and hides bound ids", async (t) => {
  const repository = await createRepositoryFixture(t)
  const conversationManagementModule = await loadConversationManagementModule()
  assert.equal(
    typeof conversationManagementModule.createConversationManagementService,
    "function",
    "lib/conversation-management.ts must export createConversationManagementService()."
  )
  const service = conversationManagementModule.createConversationManagementService!({
    repository,
    lifecycle: new ConversationLifecycleService(repository),
    stopSession: async () => undefined
  })
  const conversationId = "conversation:77777777-7777-4777-8777-777777777777"

  const created = await service.createConversation()
  assert.match(created.conversationId, /^conversation:/i)
  assert.equal(created.title, "New conversation")

  await repository.createConversation({ id: conversationId, title: "Manage me" })
  await assert.rejects(
    service.updateConversation({ conversationId, title: "   " }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error as { status?: number }).status === 400
  )
  await assert.rejects(
    service.updateConversation({ conversationId, state: "paused" }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error as { status?: number }).status === 400
  )

  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-running",
    codexThreadId: "thread-running",
    status: "running",
    turnStatus: "inProgress"
  })
  const archived = await service.updateConversation({ conversationId, state: "archived" })
  assert.equal(archived.state, "archived")

  await repository.insertConversation({
    workflowRunId: "run-bound-service",
    role: "user",
    content: "Bound workflow data must stay hidden.",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-management:service-bound"
  })
  await assert.rejects(
    service.updateConversation({
      conversationId: "run-bound-service",
      title: "Should not be visible"
    }),
    (error: unknown) =>
      typeof error === "object" &&
      error !== null &&
      "status" in error &&
      (error as { status?: number }).status === 404
  )
})

test("conversation management lifecycle commands own every local management write", async () => {
  const conversationId = "conversation:dddddddd-dddd-4ddd-8ddd-dddddddddddd"
  let metadata: ConversationMetadata = {
    conversationId,
    title: "Managed conversation",
    state: "active",
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z"
  }
  let summary: ConversationSummary = {
    conversationId,
    title: metadata.title,
    state: metadata.state,
    messageCount: 0
  }
  const events: string[] = []
  const lifecycle: ConversationManagementLifecycle = {
    createConversation: async ({ conversationId: createdConversationId, title }) => {
      events.push("lifecycle:create")
      return {
        ...metadata,
        conversationId: createdConversationId,
        title
      }
    },
    validateConversationTitle: (value) => {
      events.push("lifecycle:validate-title")
      assert.equal(value, "Renamed")
      return "Renamed"
    },
    updateConversationSettings: async (input) => {
      events.push("lifecycle:settings")
      metadata = {
        ...metadata,
        ...(input.selectedModelId === undefined
          ? {}
          : { selectedModelId: input.selectedModelId ?? undefined }),
        ...(input.selectedReasoningIntensity === undefined
          ? {}
          : { selectedReasoningIntensity: input.selectedReasoningIntensity ?? undefined })
      }
      summary = { ...summary, ...metadata }
      return metadata
    },
    renameConversation: async ({ title }) => {
      events.push("lifecycle:rename")
      metadata = { ...metadata, title }
      summary = { ...summary, title }
      return metadata
    },
    validateConversationState: (value) => {
      assert.ok(value === "active" || value === "archived")
      events.push(`lifecycle:validate-state:${value}`)
      return value
    },
    setConversationState: async ({ state }) => {
      events.push(`lifecycle:state:${state}`)
      metadata = { ...metadata, state }
      summary = { ...summary, state }
      return metadata
    },
    cancelPendingTurns: async () => {
      events.push("lifecycle:cancel")
      return 0
    },
    deleteConversation: async () => {
      events.push("lifecycle:delete")
    }
  }
  const coreWrites = new Set([
    "createConversation",
    "updateConversationProfile",
    "renameConversation",
    "setConversationState",
    "deleteConversation",
    "cancelQueuedConversationDispatches"
  ])
  const repository = new Proxy({
    getConversationMetadata: () => {
      events.push("validate")
      return metadata
    },
    getCodexSession: () => ({ conversationId }),
    listConversationSummaries: () => [summary]
  }, {
    get(target, property, receiver) {
      if (typeof property === "string" && coreWrites.has(property)) {
        return () => {
          throw new Error(`management bypassed lifecycle through ${property}`)
        }
      }
      return Reflect.get(target, property, receiver)
    }
  }) as unknown as ConversationManagementRepository
  const { createConversationManagementService } = await loadConversationManagementModule()
  assert.equal(typeof createConversationManagementService, "function")
  const service = createConversationManagementService!({
    repository,
    lifecycle,
    stopSession: async () => {
      events.push("native:stop")
    },
    renameNativeThread: async () => {
      events.push("native:rename")
    },
    setNativeThreadState: async (_conversationId, state) => {
      events.push(`native:state:${state}`)
    },
    deleteNativeThread: async () => {
      events.push("native:delete")
    }
  })

  await service.createConversation({ title: "New managed conversation" })
  await service.updateConversation({ conversationId, selectedModelId: "gpt-5.6-sol" })
  await service.updateConversation({ conversationId, title: "Renamed" })
  await service.updateConversation({ conversationId, state: "archived" })
  await service.updateConversation({ conversationId, state: "active" })
  await service.deleteConversation({ conversationId, confirm: true })

  assert.deepEqual(events, [
    "lifecycle:create",
    "validate",
    "lifecycle:settings",
    "validate",
    "lifecycle:validate-title",
    "native:rename",
    "lifecycle:rename",
    "validate",
    "lifecycle:validate-state:archived",
    "native:state:archived",
    "lifecycle:state:archived",
    "validate",
    "lifecycle:validate-state:active",
    "native:state:active",
    "lifecycle:state:active",
    "validate",
    "lifecycle:cancel",
    "native:delete",
    "native:stop",
    "lifecycle:delete"
  ])
})

test("native rename succeeds before local failure and native failure stops local rename", async (t) => {
  const repository = await createRepositoryFixture(t)
  const conversationManagementModule = await loadConversationManagementModule()
  assert.equal(
    typeof conversationManagementModule.createConversationManagementService,
    "function",
    "lib/conversation-management.ts must export createConversationManagementService()."
  )
  const originalRename = repository.renameConversation.bind(repository)
  const localFailureConversationId = "conversation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaab"
  await repository.createConversation({ id: localFailureConversationId, title: "Local title" })

  let nativeRenameCalls = 0
  repository.renameConversation = async () => {
    throw new Error("local rename failed")
  }
  const localFailureService = conversationManagementModule.createConversationManagementService!({
    repository,
    lifecycle: new ConversationLifecycleService(repository),
    stopSession: async () => undefined,
    renameNativeThread: async (conversationId, title) => {
      nativeRenameCalls += 1
      assert.equal(conversationId, localFailureConversationId)
      assert.equal(title, "Native title")
    }
  })

  await assert.rejects(
    localFailureService.updateConversation({
      conversationId: localFailureConversationId,
      title: "Native title"
    }),
    /local rename failed/
  )
  assert.equal(nativeRenameCalls, 1)
  assert.equal(
    repository.getConversationMetadata(localFailureConversationId)?.title,
    "Local title"
  )

  const nativeFailureConversationId = "conversation:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbc"
  await repository.createConversation({ id: nativeFailureConversationId, title: "Keep local title" })
  let localRenameCalls = 0
  repository.renameConversation = async (conversationId, title) => {
    localRenameCalls += 1
    return originalRename(conversationId, title)
  }
  const nativeFailureService = conversationManagementModule.createConversationManagementService!({
    repository,
    lifecycle: new ConversationLifecycleService(repository),
    stopSession: async () => undefined,
    renameNativeThread: async () => {
      throw new Error("native rename failed")
    }
  })

  await assert.rejects(
    nativeFailureService.updateConversation({
      conversationId: nativeFailureConversationId,
      title: "Do not persist"
    }),
    /native rename failed/
  )
  assert.equal(localRenameCalls, 0)
  assert.equal(
    repository.getConversationMetadata(nativeFailureConversationId)?.title,
    "Keep local title"
  )
})

test("conversation management service does not delete rows when stopSession fails", async (t) => {
  const repository = await createRepositoryFixture(t)
  const conversationManagementModule = await loadConversationManagementModule()
  assert.equal(
    typeof conversationManagementModule.createConversationManagementService,
    "function",
    "lib/conversation-management.ts must export createConversationManagementService()."
  )
  const service = conversationManagementModule.createConversationManagementService!({
    repository,
    lifecycle: new ConversationLifecycleService(repository),
    stopSession: async () => {
      throw new Error("bridge stop refused")
    }
  })
  const conversationId = "conversation:88888888-8888-4888-8888-888888888888"

  await repository.createConversation({ id: conversationId, title: "Disposable through service" })
  await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    content: "Keep every row if stop fails.",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-management:service-delete"
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-delete-service",
    codexThreadId: "thread-delete-service",
    status: "idle",
    turnStatus: "completed"
  })

  await assert.rejects(
    service.deleteConversation({ conversationId, confirm: true }),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      (error as Error & { status?: number }).status === 502 &&
      error.message === "Conversation session could not be stopped."
  )
  assert.ok(repository.getConversationMetadata(conversationId))
  assert.equal(repository.listConversation(conversationId).length, 1)
  assert.ok(repository.getCodexSession(conversationId))
})

test("conversation management service preserves known Codex stop errors", async (t) => {
  const repository = await createRepositoryFixture(t)
  const conversationManagementModule = await loadConversationManagementModule()
  assert.equal(
    typeof conversationManagementModule.createConversationManagementService,
    "function",
    "lib/conversation-management.ts must export createConversationManagementService()."
  )
  const service = conversationManagementModule.createConversationManagementService!({
    repository,
    lifecycle: new ConversationLifecycleService(repository),
    stopSession: async () => {
      throw new CodexConversationError("Codex bridge is unavailable.", 503)
    }
  })
  const conversationId = "conversation:99999999-9999-4999-8999-999999999998"

  await repository.createConversation({ id: conversationId, title: "Preserve stop error" })
  await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    content: "Keep rows for known upstream stop failures too.",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-management:service-delete-known-error"
  })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-delete-known-error",
    codexThreadId: "thread-delete-known-error",
    status: "idle",
    turnStatus: "completed"
  })

  await assert.rejects(
    service.deleteConversation({ conversationId, confirm: true }),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      (error as Error & { status?: number }).status === 503 &&
      error.message === "Codex bridge is unavailable."
  )
  assert.ok(repository.getConversationMetadata(conversationId))
  assert.equal(repository.listConversation(conversationId).length, 1)
  assert.ok(repository.getCodexSession(conversationId))
})

test("conversation management service preserves status-bearing stop errors across module boundaries", async (t) => {
  const repository = await createRepositoryFixture(t)
  const conversationManagementModule = await loadConversationManagementModule()
  assert.equal(
    typeof conversationManagementModule.createConversationManagementService,
    "function",
    "lib/conversation-management.ts must export createConversationManagementService()."
  )
  const service = conversationManagementModule.createConversationManagementService!({
    repository,
    lifecycle: new ConversationLifecycleService(repository),
    stopSession: async () => {
      throw Object.assign(new Error("dynamic bridge outage"), { status: 503 })
    }
  })
  const conversationId = "conversation:99999999-9999-4999-8999-999999999997"

  await repository.createConversation({ id: conversationId, title: "Preserve dynamic stop error" })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-delete-dynamic-error",
    codexThreadId: "thread-delete-dynamic-error",
    status: "idle",
    turnStatus: "completed"
  })

  await assert.rejects(
    service.deleteConversation({ conversationId, confirm: true }),
    (error: unknown) =>
      error instanceof Error &&
      "status" in error &&
      (error as Error & { status?: number }).status === 503 &&
      error.message === "dynamic bridge outage"
  )
  assert.ok(repository.getConversationMetadata(conversationId))
  assert.ok(repository.getCodexSession(conversationId))
})
