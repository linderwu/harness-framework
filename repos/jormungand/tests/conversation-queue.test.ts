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

async function tx2Fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-tx2-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { database, repository }
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

test("TX2 conversation dispatch rejects malformed aggregates before Runtime and continues draining", async (t) => {
  const { database, repository } = await tx2Fixture(t)
  const conversationId = "conversation:tx2-dispatch"
  await repository.createConversation({ id: conversationId, title: "TX2 dispatch" })
  const malformed = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "malformed",
    idempotencyKey: "malformed",
    responseRole: "agent"
  })
  await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "valid",
    idempotencyKey: "valid",
    responseRole: "agent"
  })
  await database.write((connection) => connection.prepare(`
    UPDATE execution_jobs SET payload_json = ? WHERE id = ?
  `).run("{", malformed.jobId))

  const claimInputs: unknown[] = []
  const claimNextConversationTurn = repository.claimNextConversationTurn.bind(repository)
  repository.claimNextConversationTurn = async (input) => {
    claimInputs.push(input)
    return await claimNextConversationTurn(input)
  }
  const started: string[] = []
  const runtimeInputs: object[] = []
  const dispatcher = new ConversationDispatcher(repository, async (input) => {
    runtimeInputs.push(input)
    started.push(input.content)
    return { status: "completed", body: "valid reply" }
  })

  await dispatcher.drain(conversationId)

  assert.deepEqual(started, ["valid"])
  assert.equal(Object.isFrozen(runtimeInputs[0]), true)
  assert.equal(claimInputs.length, 3)
  assert.equal(repository.getExecutionJob(malformed.jobId)?.status, "failed")
})

test("TX2 conversation dispatch skips a missing Entry aggregate and invokes Runtime for the next Turn", async (t) => {
  const { database, repository } = await tx2Fixture(t)
  const conversationId = "conversation:tx2-missing-entry-dispatch"
  await repository.createConversation({ id: conversationId, title: "TX2 missing entry dispatch" })
  const missing = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "missing",
    idempotencyKey: "missing",
    responseRole: "agent"
  })
  await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "valid",
    idempotencyKey: "valid",
    responseRole: "agent"
  })
  await database.write((connection) => connection.prepare(`
    UPDATE execution_jobs SET payload_json = ? WHERE id = ?
  `).run(JSON.stringify({
    conversationId,
    entryId: missing.userEntryId,
    responseEntryId: "missing-response-entry",
    targetAgent: "codex"
  }), missing.jobId))

  const started: string[] = []
  const dispatcher = new ConversationDispatcher(repository, async (input) => {
    started.push(input.content)
    return { status: "completed", body: "valid reply" }
  })

  await dispatcher.drain(conversationId)

  assert.deepEqual(started, ["valid"])
  assert.equal(repository.getExecutionJob(missing.jobId)?.status, "failed")
})

test("TX2 conversation dispatch skips an expired mixed-terminal Turn without invoking Runtime", async (t) => {
  const { database, repository } = await tx2Fixture(t)
  const conversationId = "conversation:tx2-mixed-terminal-dispatch"
  await repository.createConversation({ id: conversationId, title: "TX2 mixed terminal dispatch" })
  const mixed = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "mixed",
    idempotencyKey: "mixed",
    responseRole: "agent"
  })
  await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "valid",
    idempotencyKey: "valid-after-mixed",
    responseRole: "agent"
  })
  const claimed = await repository.claimNextConversationTurn({
    conversationId,
    leaseOwner: "tx2-mixed-terminal-worker",
    leaseDurationMs: 60_000
  })
  assert.ok(claimed && !("rejected" in claimed))
  await database.write((connection) => {
    connection.prepare("UPDATE conversation_entries SET status = 'completed' WHERE id = ?")
      .run(mixed.userEntryId)
    connection.prepare("UPDATE execution_jobs SET lease_expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", mixed.jobId)
  })

  const started: string[] = []
  const dispatcher = new ConversationDispatcher(repository, async (input) => {
    started.push(input.content)
    return { status: "completed", body: "valid reply" }
  })

  await dispatcher.drain(conversationId)

  assert.deepEqual(started, ["valid"])
  assert.equal(repository.getExecutionJob(mixed.jobId)?.status, "failed")
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => entry.status),
    ["completed", "failed", "completed", "completed"]
  )
})

test("dispatcher settles a Runtime throw through TX3 before a failed post-commit publication", async (t) => {
  const { repository } = await tx2Fixture(t)
  const conversationId = "conversation:tx3-runtime-throw"
  await repository.createConversation({ id: conversationId, title: "TX3 runtime throw" })
  const submitted = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "invoke runtime",
    idempotencyKey: "runtime-throw",
    responseRole: "agent"
  })
  const publications: unknown[] = []
  const dispatcher = new ConversationDispatcher(
    repository,
    async () => {
      throw new Error("Runtime exploded")
    },
    async (settled) => {
      publications.push(settled)
      throw new Error("publication exploded")
    }
  )

  await dispatcher.drain(conversationId)

  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => [entry.status, entry.content]),
    [
      ["failed", "invoke runtime"],
      ["failed", "Runtime exploded"]
    ]
  )
  const job = repository.getExecutionJob(submitted.jobId)
  assert.equal(job?.status, "failed")
  assert.deepEqual(JSON.parse(job?.resultJson ?? "{}"), {
    status: "failed",
    responseEntryId: submitted.responseEntryId
  })
  assert.equal(publications.length, 1)
})

test("dispatcher returns safely when settlement loses its live lease to another owner", async (t) => {
  const { database, repository } = await tx2Fixture(t)
  const conversationId = "conversation:tx3-settlement-lost-owner"
  await repository.createConversation({ id: conversationId, title: "TX3 lost owner" })
  const first = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "first",
    idempotencyKey: "lost-owner-first",
    responseRole: "agent"
  })
  const second = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "second",
    idempotencyKey: "lost-owner-second",
    responseRole: "agent"
  })
  const started: string[] = []
  const dispatcher = new ConversationDispatcher(repository, async (input) => {
    started.push(input.content)
    if (input.content === "first") {
      await database.write((connection) => connection.prepare(`
        UPDATE execution_jobs SET lease_owner = ?, lease_expires_at = ? WHERE id = ?
      `).run("other-live-worker", new Date(Date.now() + 60_000).toISOString(), first.jobId))
    }
    return { status: "completed", body: `${input.content} result` }
  })

  await dispatcher.drain(conversationId)

  assert.deepEqual(started, ["first"])
  assert.equal(repository.getExecutionJob(first.jobId)?.status, "running")
  assert.equal(repository.getExecutionJob(first.jobId)?.leaseOwner, "other-live-worker")
  assert.equal(repository.getExecutionJob(second.jobId)?.status, "queued")
})

test("dispatcher recovers an expired settlement lease and continues FIFO draining", async (t) => {
  const { database, repository } = await tx2Fixture(t)
  const conversationId = "conversation:tx3-settlement-expired-lease"
  await repository.createConversation({ id: conversationId, title: "TX3 expired lease" })
  const first = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "first",
    idempotencyKey: "expired-lease-first",
    responseRole: "agent"
  })
  const second = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "second",
    idempotencyKey: "expired-lease-second",
    responseRole: "agent"
  })
  let expireFirstSettlement = true
  const started: string[] = []
  const dispatcher = new ConversationDispatcher(repository, async (input) => {
    started.push(input.content)
    if (input.content === "first" && expireFirstSettlement) {
      expireFirstSettlement = false
      await database.write((connection) => connection.prepare(`
        UPDATE execution_jobs SET lease_expires_at = ? WHERE id = ?
      `).run("2000-01-01T00:00:00.000Z", first.jobId))
    }
    return { status: "completed", body: `${input.content} result` }
  })

  await dispatcher.drain(conversationId)

  assert.deepEqual(started, ["first", "first", "second"])
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => [entry.status, entry.content]),
    [
      ["completed", "first"],
      ["completed", "first result"],
      ["completed", "second"],
      ["completed", "second result"]
    ]
  )
  assert.equal(repository.getExecutionJob(first.jobId)?.status, "completed")
  assert.equal(repository.getExecutionJob(second.jobId)?.status, "completed")
})

test("dispatcher rethrows a durable settlement fault while its own lease remains live", async (t) => {
  const { repository } = await tx2Fixture(t)
  const conversationId = "conversation:tx3-settlement-durable-fault"
  await repository.createConversation({ id: conversationId, title: "TX3 durable fault" })
  await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "invoke runtime",
    idempotencyKey: "durable-fault",
    responseRole: "agent"
  })
  const settleConversationTurn = repository.settleConversationTurn.bind(repository)
  repository.settleConversationTurn = async () => {
    throw new Error("injected durable settlement fault")
  }
  const dispatcher = new ConversationDispatcher(repository, async () => ({
    status: "completed",
    body: "uncommitted result"
  }))

  try {
    await assert.rejects(
      () => dispatcher.drain(conversationId),
      /injected durable settlement fault/
    )
  } finally {
    repository.settleConversationTurn = settleConversationTurn
  }
})

test("dispatcher transaction spans neither pending Runtime nor concurrent conversation access", async (t) => {
  const { repository } = await tx2Fixture(t)
  const conversationId = "conversation:tx3-runtime-outside-transaction"
  await repository.createConversation({ id: conversationId, title: "TX3 outside transaction" })
  const submitted = await repository.submitConversationTurn({
    conversationId,
    targetAgent: "codex",
    content: "pending runtime",
    idempotencyKey: "outside-transaction",
    responseRole: "agent"
  })
  const runtimeStarted = deferred<void>()
  const runtimeResult = deferred<{ status: "completed"; body: string }>()
  const dispatcher = new ConversationDispatcher(repository, async () => {
    runtimeStarted.resolve()
    return runtimeResult.promise
  })
  const drain = dispatcher.drain(conversationId)
  await runtimeStarted.promise

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      Promise.all([
        Promise.resolve(repository.getExecutionJob(submitted.jobId)),
        repository.updateConversationProfile({
          id: conversationId,
          selectedModelId: "gpt-5.4"
        })
      ]),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Runtime held the database transaction.")), 1_000)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }

  runtimeResult.resolve({ status: "completed", body: "committed after Runtime" })
  await drain
  assert.deepEqual(
    repository.listConversation(conversationId).map((entry) => entry.status),
    ["completed", "completed"]
  )
  assert.equal(repository.getExecutionJob(submitted.jobId)?.status, "completed")
})
