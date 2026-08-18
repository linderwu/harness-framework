import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { setTimeout as delay } from "node:timers/promises"
import { legacyConversationId } from "../lib/conversation-identity"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

type ConversationState = "active" | "archived"

interface ConversationMetadata {
  conversationId: string
  title: string
  state: ConversationState
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

type ConversationManagementRepository = ReturnType<typeof createHiveMemoryRepository> & {
  createConversation(input: { id: string; title: string }): Promise<ConversationMetadata>
  getConversationMetadata(id: string): ConversationMetadata | undefined
  listConversationSummaries(input?: { includeArchived?: boolean }): ConversationSummary[]
  renameConversation(id: string, title: string): Promise<ConversationMetadata>
  setConversationState(id: string, state: ConversationState): Promise<ConversationMetadata>
  isConversationRunning(id: string): boolean
  deleteConversation(id: string): Promise<void>
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

  await repository.deleteConversation(conversationId)
  assert.equal(repository.getConversationMetadata(conversationId), undefined)
  assert.deepEqual(repository.listConversation(conversationId), [])
  assert.equal(repository.getCodexSession(conversationId), undefined)

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
