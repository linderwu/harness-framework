import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ConversationDispatcher, ConversationQueueService } from "../lib/conversation-dispatcher"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

async function repositoryFixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-queue-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return repository
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve
  })
  return { promise, resolve }
}

test("conversation queue keeps messages FIFO and cancels queued entries", async (t) => {
  const repository = await repositoryFixture(t)
  const queue = new ConversationQueueService(repository)

  const first = await queue.enqueue({
    conversationId: "conversation:queue-a",
    targetAgent: "codex",
    content: "first",
    idempotencyKey: "queue-one"
  })
  const second = await queue.enqueue({
    conversationId: "conversation:queue-a",
    targetAgent: "codex",
    content: "second",
    idempotencyKey: "queue-two"
  })

  assert.equal(first.userEntry.status, "queued")
  assert.equal(second.userEntry.status, "queued")
  assert.deepEqual(
    queue.listPending("conversation:queue-a").map((entry) => entry.content),
    ["first", "second"]
  )

  const canceled = await queue.cancelPending("conversation:queue-a")

  assert.equal(canceled, 2)
  assert.deepEqual(
    repository.listConversation("conversation:queue-a").map((entry) => entry.status),
    ["canceled", "canceled", "canceled", "canceled"]
  )
})

test("conversation dispatch claims one job per conversation and renews its lease", async (t) => {
  const repository = await repositoryFixture(t)
  const first = await repository.createConversationDispatch({
    conversationId: "conversation:claim-a",
    entryId: "entry-one",
    targetAgent: "codex",
    idempotencyKey: "dispatch-one"
  })
  const second = await repository.createConversationDispatch({
    conversationId: "conversation:claim-a",
    entryId: "entry-two",
    targetAgent: "codex",
    idempotencyKey: "dispatch-two"
  })

  const claimed = await repository.claimNextConversationDispatch({
    conversationId: "conversation:claim-a",
    leaseOwner: "worker-one",
    leaseDurationMs: 60_000
  })
  assert.equal(claimed?.id, first.job.id)
  const renewed = await repository.renewExecutionJobLease({
    id: first.job.id,
    leaseOwner: "worker-one",
    leaseDurationMs: 120_000
  })
  assert.equal(renewed.leaseOwner, "worker-one")
  assert.ok(Date.parse(renewed.leaseExpiresAt ?? "") > Date.parse(claimed?.leaseExpiresAt ?? ""))

  const blocked = await repository.claimNextConversationDispatch({
    conversationId: "conversation:claim-a",
    leaseOwner: "worker-two",
    leaseDurationMs: 60_000
  })
  assert.equal(blocked, undefined)
  assert.equal(repository.getExecutionJob(second.job.id)?.status, "queued")
})

test("dispatcher processes the next message only after the active dispatch completes", async (t) => {
  const repository = await repositoryFixture(t)
  const queue = new ConversationQueueService(repository)
  await queue.enqueue({
    conversationId: "conversation:dispatch-a",
    targetAgent: "codex",
    content: "first",
    idempotencyKey: "dispatch-message-one"
  })
  await queue.enqueue({
    conversationId: "conversation:dispatch-a",
    targetAgent: "codex",
    content: "second",
    idempotencyKey: "dispatch-message-two"
  })

  const releaseFirst = deferred<{ status: "completed"; body: string }>()
  const started: string[] = []
  const dispatcher = new ConversationDispatcher(repository, async (input) => {
    started.push(input.content)
    if (input.content === "first") return releaseFirst.promise
    return { status: "completed", body: "second reply" }
  })

  const drain = dispatcher.drain("conversation:dispatch-a")
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(started, ["first"])
  assert.equal(repository.listConversation("conversation:dispatch-a")[2]?.status, "queued")

  releaseFirst.resolve({ status: "completed", body: "first reply" })
  await drain

  assert.deepEqual(started, ["first", "second"])
  assert.deepEqual(
    repository.listConversation("conversation:dispatch-a").map((entry) => entry.status),
    ["completed", "completed", "completed", "completed"]
  )
})
