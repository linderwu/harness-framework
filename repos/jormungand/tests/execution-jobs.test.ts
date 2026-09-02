import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { hiveSchemaVersion, openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import type { ExecutionJob, ExecutionJobJsonValue } from "../lib/execution-jobs"

type ExecutionJobsRepository = ReturnType<typeof createHiveMemoryRepository> & {
  createExecutionJob(input: {
    kind: string
    workflowRunId?: string
    payload: ExecutionJobJsonValue
    idempotencyKey: string
    availableAt?: string
  }): Promise<{ job: ExecutionJob; inserted: boolean }>
  getExecutionJob(id: string): ExecutionJob | undefined
  getExecutionJobByIdempotencyKey(idempotencyKey: string): ExecutionJob | undefined
  claimNextExecutionJob(input: {
    leaseOwner: string
    leaseDurationMs: number
    now?: string
    kind?: string
    workflowRunId?: string
  }): Promise<ExecutionJob | undefined>
  completeExecutionJob(input: {
    id: string
    leaseOwner: string
    result: ExecutionJobJsonValue
    now?: string
  }): Promise<ExecutionJob>
  failExecutionJob(input: {
    id: string
    leaseOwner: string
    error: string
    now?: string
  }): Promise<ExecutionJob>
  requeueExecutionJob(input: {
    id: string
    now?: string
    availableAt?: string
  }): Promise<ExecutionJob>
  cancelExecutionJob(input: {
    id: string
    now?: string
  }): Promise<ExecutionJob>
  recoverExpiredExecutionJobs(input?: {
    now?: string
    kind?: string
    workflowRunId?: string
  }): Promise<number>
}

async function openRepository(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-execution-jobs-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return createHiveMemoryRepository(database) as ExecutionJobsRepository
}

function createJobInput() {
  return {
    kind: "worker_handoff",
    workflowRunId: "run-1",
    payload: { step: 1 },
    idempotencyKey: "execution-job-1",
    availableAt: "2026-08-20T00:00:00.000Z"
  }
}

test("current schema migrates a v5 fixture and creates durable execution job storage", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-execution-jobs-schema-"))
  const databasePath = join(dataDir, "hive-memory.sqlite")
  const seed = new Database(databasePath)
  seed.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE codex_sessions (
      conversation_id TEXT PRIMARY KEY,
      bridge_session_id TEXT NOT NULL UNIQUE,
      codex_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      turn_status TEXT NOT NULL,
      current_turn_id TEXT,
      cursor INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'archived')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      archived_at TEXT
    );
  `)
  seed.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(5, "2026-08-20T00:00:00.000Z")
  seed.close()

  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  assert.equal(database.schemaVersion(), hiveSchemaVersion)
  const tableNames = database.read((connection) =>
    connection.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = 'execution_jobs'
    `).all() as Array<{ name: string }>
  )
  const indexNames = database.read((connection) =>
    connection.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'index' AND name IN ('execution_jobs_status_available_idx', 'execution_jobs_lease_expires_idx')
      ORDER BY name ASC
    `).all() as Array<{ name: string }>
  )

  assert.deepEqual(tableNames.map((row) => row.name), ["execution_jobs"])
  assert.deepEqual(indexNames.map((row) => row.name), [
    "execution_jobs_lease_expires_idx",
    "execution_jobs_status_available_idx"
  ])
})

test("enqueueing the same execution job idempotency key returns the original row", async (t) => {
  const repository = await openRepository(t)

  const first = await repository.createExecutionJob(createJobInput())
  assert.equal(first.inserted, true)
  assert.equal(first.job.status, "queued")
  assert.equal(first.job.attemptCount, 0)

  const duplicate = await repository.createExecutionJob({
    ...createJobInput(),
    payload: { step: 2 }
  })
  assert.equal(duplicate.inserted, false)
  assert.equal(duplicate.job.id, first.job.id)
  assert.equal(duplicate.job.payloadJson, first.job.payloadJson)
})

test("claiming a queued execution job moves it to running and completes it", async (t) => {
  const repository = await openRepository(t)
  const created = await repository.createExecutionJob(createJobInput())

  const claimed = await repository.claimNextExecutionJob({
    leaseOwner: "worker-a",
    leaseDurationMs: 30_000,
    now: "2026-08-20T00:00:00.000Z"
  })

  assert.ok(claimed)
  assert.equal(claimed?.id, created.job.id)
  assert.equal(claimed?.status, "running")
  assert.equal(claimed?.attemptCount, 1)
  assert.equal(claimed?.leaseOwner, "worker-a")

  const completed = await repository.completeExecutionJob({
    id: created.job.id,
    leaseOwner: "worker-a",
    result: { ok: true },
    now: "2026-08-20T00:00:05.000Z"
  })

  assert.equal(completed.status, "completed")
  assert.equal(completed.completedAt, "2026-08-20T00:00:05.000Z")
  assert.equal(completed.resultJson, JSON.stringify({ ok: true }))
  assert.equal(repository.getExecutionJob(created.job.id)?.status, "completed")
})

test("failed execution jobs can be requeued and claimed again", async (t) => {
  const repository = await openRepository(t)
  const created = await repository.createExecutionJob(createJobInput())
  const claimed = await repository.claimNextExecutionJob({
    leaseOwner: "worker-a",
    leaseDurationMs: 30_000,
    now: "2026-08-20T01:00:00.000Z"
  })

  assert.ok(claimed)

  const failed = await repository.failExecutionJob({
    id: created.job.id,
    leaseOwner: "worker-a",
    error: "retry me",
    now: "2026-08-20T01:00:01.000Z"
  })
  assert.equal(failed.status, "failed")
  assert.equal(failed.lastError, "retry me")

  const requeued = await repository.requeueExecutionJob({
    id: created.job.id,
    now: "2026-08-20T01:00:02.000Z"
  })
  assert.equal(requeued.status, "queued")
  assert.equal(requeued.lastError, undefined)

  const reclaimed = await repository.claimNextExecutionJob({
    leaseOwner: "worker-b",
    leaseDurationMs: 30_000,
    now: "2026-08-20T01:00:03.000Z"
  })

  assert.ok(reclaimed)
  assert.equal(reclaimed?.attemptCount, 2)
  assert.equal(reclaimed?.leaseOwner, "worker-b")
  assert.equal(reclaimed?.lastError, undefined)
})

test("execution jobs reject undefined and non-JSON payloads and results before persistence", async (t) => {
  const repository = await openRepository(t)

  await assert.rejects(
    repository.createExecutionJob({
      ...createJobInput(),
      payload: undefined as never
    }),
    /payload must be JSON-serializable/i
  )

  await assert.rejects(
    repository.createExecutionJob({
      ...createJobInput(),
      idempotencyKey: "execution-job-bigint",
      payload: { count: BigInt(1) } as never
    }),
    /payload must be JSON-serializable/i
  )

  const created = await repository.createExecutionJob({
    ...createJobInput(),
    idempotencyKey: "execution-job-result"
  })
  await repository.claimNextExecutionJob({
    leaseOwner: "worker-a",
    leaseDurationMs: 30_000,
    now: "2026-08-20T06:00:00.000Z"
  })

  await assert.rejects(
    repository.completeExecutionJob({
      id: created.job.id,
      leaseOwner: "worker-a",
      result: undefined as never,
      now: "2026-08-20T06:00:01.000Z"
    }),
    /result must be JSON-serializable/i
  )

  const stillRunning = repository.getExecutionJob(created.job.id)
  assert.equal(stillRunning?.status, "running")
  assert.equal(stillRunning?.resultJson, undefined)
})

test("canceled execution jobs cannot be claimed again", async (t) => {
  const repository = await openRepository(t)
  const created = await repository.createExecutionJob(createJobInput())

  const canceled = await repository.cancelExecutionJob({
    id: created.job.id,
    now: "2026-08-20T02:00:00.000Z"
  })

  assert.equal(canceled.status, "canceled")
  assert.equal(await repository.claimNextExecutionJob({
    leaseOwner: "worker-a",
    leaseDurationMs: 30_000,
    now: "2026-08-20T02:00:01.000Z"
  }), undefined)
})

test("expired execution job leases are recovered into queued jobs before the next claim", async (t) => {
  const repository = await openRepository(t)
  const created = await repository.createExecutionJob(createJobInput())

  const claimed = await repository.claimNextExecutionJob({
    leaseOwner: "worker-a",
    leaseDurationMs: 1,
    now: "2026-08-20T03:00:00.000Z"
  })
  assert.ok(claimed)

  const recoveredCount = await repository.recoverExpiredExecutionJobs({
    now: "2026-08-20T03:00:01.000Z"
  })
  assert.equal(recoveredCount, 1)
  assert.equal(repository.getExecutionJob(created.job.id)?.status, "queued")

  const reclaimed = await repository.claimNextExecutionJob({
    leaseOwner: "worker-b",
    leaseDurationMs: 30_000,
    now: "2026-08-20T03:00:02.000Z"
  })

  assert.ok(reclaimed)
  assert.equal(reclaimed?.attemptCount, 2)
  assert.equal(reclaimed?.leaseOwner, "worker-b")
})

test("execution job failures truncate stored errors at 500 characters", async (t) => {
  const repository = await openRepository(t)
  const created = await repository.createExecutionJob(createJobInput())
  await repository.claimNextExecutionJob({
    leaseOwner: "worker-a",
    leaseDurationMs: 30_000,
    now: "2026-08-20T04:00:00.000Z"
  })

  const failed = await repository.failExecutionJob({
    id: created.job.id,
    leaseOwner: "worker-a",
    error: "x".repeat(600),
    now: "2026-08-20T04:00:01.000Z"
  })

  assert.equal(failed.lastError?.length, 500)
  assert.equal(repository.getExecutionJob(created.job.id)?.lastError?.length, 500)
})

test("execution job transitions reject invalid ownership and states", async (t) => {
  const repository = await openRepository(t)
  const created = await repository.createExecutionJob(createJobInput())
  await repository.claimNextExecutionJob({
    leaseOwner: "worker-a",
    leaseDurationMs: 30_000,
    now: "2026-08-20T05:00:00.000Z"
  })

  await assert.rejects(
    repository.completeExecutionJob({
      id: created.job.id,
      leaseOwner: "worker-b",
      result: { ok: true },
      now: "2026-08-20T05:00:01.000Z"
    }),
    /leased to another owner/i
  )

  await assert.rejects(
    repository.cancelExecutionJob({
      id: created.job.id,
      now: "2026-08-20T05:00:02.000Z"
    }),
    /must be queued/i
  )
})
