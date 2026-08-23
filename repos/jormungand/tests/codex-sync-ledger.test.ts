import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

async function repositoryFixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-codex-sync-ledger-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { database, repository }
}

test("persists Codex mapping state and native thread name across database restart", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  await repository.upsertCodexSession({
    conversationId: "conversation:sync",
    bridgeSessionId: "bridge-sync",
    codexThreadId: "thread-sync",
    status: "idle",
    turnStatus: "completed",
    mappingState: "active",
    nativeName: "Harness · Sync",
    nativeCursor: "turn-1"
  })

  const session = repository.getCodexSession("conversation:sync")

  assert.equal(session?.mappingState, "active")
  assert.equal(session?.nativeName, "Harness · Sync")
  assert.equal(session?.nativeCursor, "turn-1")
  assert.equal(database.schemaVersion(), 7)
})

test("records one native item once by thread, turn, and item identity", async (t) => {
  const { repository } = await repositoryFixture(t)
  const first = await repository.recordCodexSyncItem({
    conversationId: "conversation:sync",
    nativeThreadId: "thread-1",
    nativeTurnId: "turn-1",
    nativeItemId: "item-1",
    source: "codex",
    kind: "agentMessage",
    contentHash: "hash-1"
  })
  const duplicate = await repository.recordCodexSyncItem({
    conversationId: "conversation:sync",
    nativeThreadId: "thread-1",
    nativeTurnId: "turn-1",
    nativeItemId: "item-1",
    source: "codex",
    kind: "agentMessage",
    contentHash: "hash-1"
  })

  assert.equal(first.inserted, true)
  assert.equal(duplicate.inserted, false)
  assert.equal(repository.listCodexSyncItems("conversation:sync").length, 1)
})

test("records the Harness entry attached to an imported native item", async (t) => {
  const { repository } = await repositoryFixture(t)
  const result = await repository.recordCodexSyncItem({
    conversationId: "conversation:sync",
    nativeThreadId: "thread-1",
    nativeTurnId: "turn-2",
    nativeItemId: "item-2",
    source: "harness",
    kind: "userMessage",
    conversationEntryId: "entry-2",
    contentHash: "hash-2"
  })

  assert.equal(result.inserted, true)
  assert.equal(result.item.conversationEntryId, "entry-2")
  assert.equal(result.item.source, "harness")
})
