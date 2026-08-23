import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createCodexSyncWorker } from "../lib/codex-sync-worker"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

async function repositoryFixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-codex-sync-worker-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return repository
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

test("worker scans active Codex mappings without a browser request", async (t) => {
  const repository = await repositoryFixture(t)
  await repository.upsertCodexSession({
    conversationId: "conversation:worker",
    bridgeSessionId: "bridge-worker",
    codexThreadId: "thread-worker",
    status: "idle",
    turnStatus: "completed"
  })
  const synced: string[] = []
  const worker = createCodexSyncWorker({
    repository,
    syncConversation: async (conversationId) => {
      synced.push(conversationId)
    }
  })

  await worker.tick()

  assert.deepEqual(synced, ["conversation:worker"])
})

test("worker marks a transient sync failure offline without deleting the mapping", async (t) => {
  const repository = await repositoryFixture(t)
  await repository.upsertCodexSession({
    conversationId: "conversation:offline",
    bridgeSessionId: "bridge-offline",
    codexThreadId: "thread-offline",
    status: "idle",
    turnStatus: "completed"
  })
  const worker = createCodexSyncWorker({
    repository,
    syncConversation: async () => {
      throw new Error("bridge offline")
    }
  })

  await worker.tick()

  assert.equal(repository.getCodexSession("conversation:offline")?.mappingState, "offline")
  assert.equal(repository.getCodexSession("conversation:offline")?.codexThreadId, "thread-offline")
})

test("worker does not overlap ticks", async (t) => {
  const repository = await repositoryFixture(t)
  await repository.upsertCodexSession({
    conversationId: "conversation:overlap",
    bridgeSessionId: "bridge-overlap",
    codexThreadId: "thread-overlap",
    status: "idle",
    turnStatus: "completed"
  })
  const gate = deferred()
  let calls = 0
  const worker = createCodexSyncWorker({
    repository,
    syncConversation: async () => {
      calls += 1
      await gate.promise
    }
  })

  const first = worker.tick()
  const second = worker.tick()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(calls, 1)
  gate.resolve()
  await Promise.all([first, second])
})
