import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  ConversationTurnRepositoryError,
  createHiveMemoryRepository,
  type SubmittedConversationTurn
} from "../lib/hive-memory/repository"
import { openHiveDatabase } from "../lib/hive-memory/database"

async function tx1Fixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-tx1-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:tx1"
  await repository.createConversation({ id: conversationId, title: "TX1" })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { database, repository, conversationId }
}

function turnInput(conversationId: string, idempotencyKey = "turn-1") {
  return {
    conversationId,
    targetAgent: "codex" as const,
    content: "  Preserve this exact user content.  ",
    idempotencyKey,
    responseRole: "manager" as const
  }
}

function durableTurnRows(
  database: Awaited<ReturnType<typeof tx1Fixture>>["database"],
  conversationId: string
) {
  return database.read((connection) => ({
    entries: connection.prepare(`
      SELECT id, workflow_run_id, role, agent_id, content, importance, status, reply_to_id, idempotency_key
      FROM conversation_entries WHERE workflow_run_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(conversationId) as Array<Record<string, unknown>>,
    jobs: connection.prepare(`
      SELECT id, kind, workflow_run_id, payload_json, idempotency_key, status
      FROM execution_jobs WHERE workflow_run_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(conversationId) as Array<Record<string, unknown>>
  }))
}

test("TX1 SubmitTurn persists the user, response placeholder, and dispatch job as one aggregate", async (t) => {
  const { database, repository, conversationId } = await tx1Fixture(t)
  const input = turnInput(conversationId)

  const result = await repository.submitConversationTurn(input)
  const durable = durableTurnRows(database, conversationId)
  const [user, response] = durable.entries
  const [job] = durable.jobs

  assert.equal(result.duplicate, false)
  assert.equal(result.conversationId, conversationId)
  assert.equal(result.idempotencyKey, "turn-1")
  assert.equal(result.userEntry.id, result.userEntryId)
  assert.equal(result.responseEntry.id, result.responseEntryId)
  assert.equal(result.jobId, job?.id)
  assert.equal(result.jobStatus, "queued")
  assert.equal(durable.entries.length, 2)
  assert.equal(durable.jobs.length, 1)
  assert.deepEqual(user, {
    id: result.userEntryId,
    workflow_run_id: conversationId,
    role: "user",
    agent_id: "codex",
    content: input.content,
    importance: "normal",
    status: "queued",
    reply_to_id: null,
    idempotency_key: `${conversationId}:turn-1`
  })
  assert.deepEqual(response, {
    id: result.responseEntryId,
    workflow_run_id: conversationId,
    role: "manager",
    agent_id: "codex",
    content: "Queued for agent response...",
    importance: "important",
    status: "queued",
    reply_to_id: result.userEntryId,
    idempotency_key: `${conversationId}:turn-1:response`
  })
  assert.equal(job?.kind, "conversation_dispatch")
  assert.equal(job?.workflow_run_id, conversationId)
  assert.equal(job?.idempotency_key, `${conversationId}:turn-1:dispatch`)
  assert.equal(job?.status, "queued")
  assert.deepEqual(JSON.parse(String(job?.payload_json)), {
    conversationId,
    entryId: result.userEntryId,
    responseEntryId: result.responseEntryId,
    targetAgent: "codex"
  })
})

test("TX1 SubmitTurn returns stable identities for sequential duplicates", async (t) => {
  const { database, repository, conversationId } = await tx1Fixture(t)
  const input = turnInput(conversationId, "dedupe")

  const first = await repository.submitConversationTurn(input)
  const sequential = await repository.submitConversationTurn(input)
  const durable = durableTurnRows(database, conversationId)

  assert.equal(sequential.duplicate, true)
  assert.equal(sequential.userEntryId, first.userEntryId)
  assert.equal(sequential.responseEntryId, first.responseEntryId)
  assert.equal(sequential.jobId, first.jobId)
  assert.equal(durable.entries.length, 2)
  assert.equal(durable.jobs.length, 1)
})

test("TX1 SubmitTurn keeps encoded key segments in distinct durable aggregates", async (t) => {
  const { database, repository, conversationId } = await tx1Fixture(t)
  const keys = [
    "collision",
    "collision:response",
    "collision:dispatch",
    "collision%3Aresponse",
    "電:話"
  ]
  const inputs = keys.map((idempotencyKey) => turnInput(conversationId, idempotencyKey))
  const submitted: SubmittedConversationTurn[] = []
  for (const input of inputs) {
    submitted.push(await repository.submitConversationTurn(input))
  }
  const retries: SubmittedConversationTurn[] = []
  for (const input of inputs) {
    retries.push(await repository.submitConversationTurn(input))
  }
  const durable = durableTurnRows(database, conversationId)

  assert.deepEqual(submitted.map((result) => result.duplicate), [false, false, false, false, false])
  assert.deepEqual(submitted.map((result) => result.idempotencyKey), keys)
  assert.equal(new Set(submitted.flatMap((result) => [
    result.userEntryId,
    result.responseEntryId,
    result.jobId
  ])).size, 15)
  assert.equal(durable.entries.length, 10)
  assert.equal(durable.jobs.length, 5)
  assert.equal(new Set(durable.entries.map((entry) => entry.idempotency_key)).size, 10)
  assert.equal(new Set(durable.jobs.map((job) => job.idempotency_key)).size, 5)
  for (const [index, retry] of retries.entries()) {
    const original = submitted[index]!
    assert.equal(retry.duplicate, true)
    assert.equal(retry.userEntryId, original.userEntryId)
    assert.equal(retry.responseEntryId, original.responseEntryId)
    assert.equal(retry.jobId, original.jobId)
  }
})

test("TX1 SubmitTurn resolves concurrent empty-store submissions to one durable aggregate", async (t) => {
  const { database, repository, conversationId } = await tx1Fixture(t)
  const input = turnInput(conversationId, "concurrent-first")

  const results = await Promise.all([
    repository.submitConversationTurn(input),
    repository.submitConversationTurn(input)
  ])
  const [first, second] = results
  const created = results.filter((result) => !result.duplicate)
  const duplicates = results.filter((result) => result.duplicate)
  const durable = durableTurnRows(database, conversationId)
  const [user, response] = durable.entries
  const [job] = durable.jobs

  assert.equal(created.length, 1)
  assert.equal(duplicates.length, 1)
  assert.equal(first?.conversationId, conversationId)
  assert.equal(second?.conversationId, conversationId)
  assert.equal(first?.idempotencyKey, "concurrent-first")
  assert.equal(second?.idempotencyKey, "concurrent-first")
  assert.equal(first?.userEntryId, second?.userEntryId)
  assert.equal(first?.responseEntryId, second?.responseEntryId)
  assert.equal(first?.jobId, second?.jobId)
  assert.equal(durable.entries.length, 2)
  assert.equal(durable.jobs.length, 1)
  assert.equal(user?.id, first?.userEntryId)
  assert.equal(user?.idempotency_key, `${conversationId}:concurrent-first`)
  assert.equal(response?.id, first?.responseEntryId)
  assert.equal(response?.reply_to_id, first?.userEntryId)
  assert.equal(response?.idempotency_key, `${conversationId}:concurrent-first:response`)
  assert.equal(job?.id, first?.jobId)
  assert.equal(job?.idempotency_key, `${conversationId}:concurrent-first:dispatch`)
  assert.deepEqual(JSON.parse(String(job?.payload_json)), {
    conversationId,
    entryId: first?.userEntryId,
    responseEntryId: first?.responseEntryId,
    targetAgent: "codex"
  })
})

test("TX1 SubmitTurn rejects missing and archived conversations before inserting durable rows", async (t) => {
  const { database, repository, conversationId } = await tx1Fixture(t)
  const missingId = "conversation:missing-tx1"

  await assert.rejects(
    () => repository.submitConversationTurn(turnInput(missingId, "missing")),
    (error: unknown) => error instanceof ConversationTurnRepositoryError && error.code === "conversation_not_found"
  )
  assert.deepEqual(durableTurnRows(database, missingId), { entries: [], jobs: [] })

  await repository.setConversationState(conversationId, "archived")
  await assert.rejects(
    () => repository.submitConversationTurn(turnInput(conversationId, "archived")),
    (error: unknown) => error instanceof ConversationTurnRepositoryError && error.code === "conversation_not_active"
  )
  assert.deepEqual(durableTurnRows(database, conversationId), { entries: [], jobs: [] })
})

test("TX1 SubmitTurn rolls back the user Entry when response insertion fails", async (t) => {
  const { database, repository, conversationId } = await tx1Fixture(t)
  await database.write((connection) => connection.exec(`
    CREATE TEMP TRIGGER fail_tx1_response
    BEFORE INSERT ON conversation_entries
    WHEN NEW.idempotency_key LIKE '%:response'
    BEGIN
      SELECT RAISE(ABORT, 'injected response failure');
    END;
  `))
  try {
    await assert.rejects(() => repository.submitConversationTurn(turnInput(conversationId, "response-failure")), /injected response failure/)
    assert.deepEqual(durableTurnRows(database, conversationId), { entries: [], jobs: [] })
  } finally {
    await database.write((connection) => connection.exec("DROP TRIGGER IF EXISTS fail_tx1_response"))
  }
})

test("TX1 SubmitTurn rolls back both Entries when job insertion fails", async (t) => {
  const { database, repository, conversationId } = await tx1Fixture(t)
  await database.write((connection) => connection.exec(`
    CREATE TEMP TRIGGER fail_tx1_job
    BEFORE INSERT ON execution_jobs
    WHEN NEW.idempotency_key LIKE '%:dispatch'
    BEGIN
      SELECT RAISE(ABORT, 'injected job failure');
    END;
  `))
  try {
    await assert.rejects(() => repository.submitConversationTurn(turnInput(conversationId, "job-failure")), /injected job failure/)
    assert.deepEqual(durableTurnRows(database, conversationId), { entries: [], jobs: [] })
  } finally {
    await database.write((connection) => connection.exec("DROP TRIGGER IF EXISTS fail_tx1_job"))
  }
})

test("TX1 SubmitTurn rejects incomplete duplicate records without repairing them", async (t) => {
  const { database, repository, conversationId } = await tx1Fixture(t)
  const input = turnInput(conversationId, "incomplete")
  await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: input.targetAgent,
    content: input.content,
    importance: "normal",
    status: "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: `${conversationId}:${input.idempotencyKey}`
  })

  await assert.rejects(
    () => repository.submitConversationTurn(input),
    (error: unknown) => error instanceof ConversationTurnRepositoryError && error.code === "incomplete_turn_record"
  )
  const durable = durableTurnRows(database, conversationId)
  assert.equal(durable.entries.length, 1)
  assert.equal(durable.jobs.length, 0)
  assert.equal(durable.entries[0]?.idempotency_key, `${conversationId}:${input.idempotencyKey}`)
})

test("TX1 SubmitTurn rejects malformed UTF-16 idempotency keys without durable writes", async (t) => {
  const { database, repository, conversationId } = await tx1Fixture(t)

  for (const idempotencyKey of ["\uD800", "\uDC00"]) {
    await assert.rejects(
      () => repository.submitConversationTurn(turnInput(conversationId, idempotencyKey)),
      (error: unknown) =>
        error instanceof ConversationTurnRepositoryError &&
        error.code === "invalid_idempotency_key"
    )
    assert.deepEqual(durableTurnRows(database, conversationId), { entries: [], jobs: [] })
  }
})
