import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { mkdtemp, mkdir, lstat, realpath, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { TestContext } from "node:test"
import type { ContextPack } from "../lib/context-builder"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import type { ManagerProposal, WorkflowRun } from "../lib/types"
import { createHiveMissionConfig } from "../lib/managed-workflows"
import { createWorkflowRun } from "../lib/workflow"

async function ensureCompiledAlias() {
  const tmpRoot = join(process.cwd(), ".tmp-tests")
  const scopedRoot = join(tmpRoot, "node_modules", "@")
  const libLink = join(scopedRoot, "lib")
  const expectedTarget = join(tmpRoot, "lib")

  await mkdir(scopedRoot, { recursive: true })
  const existingLink = await lstat(libLink).catch(() => undefined)
  const existingTarget = existingLink?.isSymbolicLink()
    ? await realpath(libLink).catch(() => undefined)
    : undefined
  const expectedRealTarget = await realpath(expectedTarget).catch(() => undefined)

  if (existingTarget && expectedRealTarget && existingTarget === expectedRealTarget) {
    return
  }
  if (existingLink) {
    await rm(libLink, { recursive: true, force: true })
  }
  await symlink(expectedTarget, libLink, "junction").catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw error
    }
  })
}

function createManagedRun() {
  return createWorkflowRun({
    projectId: "project-a2a",
    projectName: "A2A Mission",
    projectType: "hive_mission",
    repository: "owner/repo",
    requirement: "Persist bridge and worker handoffs",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human",
    managedConfig: createHiveMissionConfig({
      repositoryScope: "owner/repo",
      successCriteria: ["Persist worker evidence"],
      constraints: [],
      nonGoals: [],
      budget: {
        callLimit: 4,
        timeLimitMs: 600_000,
        costLimitUsd: 5
      }
    })
  })
}

test("schema v5 adds recipient_agent and preserves conversation rows while round-tripping recipient metadata", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-v5-"))
  const databasePath = join(dataDir, "hive-memory.sqlite")
  const seed = new Database(databasePath)
  seed.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE conversation_entries (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      task_id TEXT,
      role TEXT NOT NULL,
      agent_id TEXT,
      content TEXT NOT NULL,
      importance TEXT NOT NULL,
      status TEXT NOT NULL,
      reply_to_id TEXT,
      artifact_ids_json TEXT NOT NULL,
      memory_ids_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
  `)
  for (const version of [1, 2, 3, 4]) {
    seed.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
      .run(version, `2026-08-18T00:0${version}:00.000Z`)
  }
  seed.prepare(`
    INSERT INTO conversation_entries(
      id, workflow_run_id, task_id, role, agent_id, content, importance,
      status, reply_to_id, artifact_ids_json, memory_ids_json, idempotency_key, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    "entry-legacy",
    "run-legacy",
    "task-legacy",
    "agent",
    "openclaw.rowlet",
    "Legacy worker handoff",
    "important",
    "completed",
    null,
    "[]",
    "[]",
    "legacy-entry-key",
    "2026-08-18T01:00:00.000Z"
  )
  seed.close()

  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  assert.equal(database.schemaVersion(), 5)
  const migratedColumns = database.read((connection) =>
    connection.prepare("PRAGMA table_info(conversation_entries)").all() as Array<{ name: string }>
  )
  assert.equal(migratedColumns.some((column) => column.name === "recipient_agent"), true)

  const preserved = repository.listConversation("run-legacy")
  assert.equal(preserved[0]?.recipientAgent, undefined)
  assert.equal(preserved[0]?.content, "Legacy worker handoff")

  const inserted = await repository.insertConversation({
    workflowRunId: "run-new",
    taskId: "task-new",
    role: "agent",
    agentId: "openclaw.gengar",
    recipientAgent: "codex",
    content: "Fresh worker handoff",
    importance: "important",
    status: "completed",
    artifactIds: ["artifact-new"],
    memoryIds: [],
    idempotencyKey: "new-entry-key"
  })

  assert.equal(inserted.entry.recipientAgent, "codex")
  assert.equal(repository.getConversationEntry(inserted.entry.id)?.recipientAgent, "codex")
})

test("Hive services persist worker handoffs before the wake and expose them in the next manager context", async (t) => {
  await ensureCompiledAlias()
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-worker-handoff-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  let run = createManagedRun()
  const managerContexts: ContextPack[] = []
  let managerInvocations = 0

  const proposal = (taskId: string): ManagerProposal => managerInvocations === 0
    ? {
        observation: "Dispatch the worker task.",
        decision: "Send the task to Rowlet.",
        reason: "The task is ready.",
        proposed_actions: [{ type: "dispatch_task", taskId, agentId: "openclaw.rowlet" }],
        memory_changes: [],
        approval_requests: [],
        next_wake_condition: "worker_completed"
      }
    : {
        observation: "Worker evidence is present.",
        decision: "Mark the mission complete.",
        reason: "The manager can see the handoff.",
        proposed_actions: [],
        memory_changes: [],
        approval_requests: [],
        next_wake_condition: "mission_completed"
      }

  const { createHiveServices } = await import("../lib/hive-services") as typeof import("../lib/hive-services")
  const services = createHiveServices({
    database,
    repository,
    getRun: async (id: string) => id === run.id ? run : undefined,
    saveRun: async (next: WorkflowRun) => {
      run = { ...next, version: run.version + 1 }
      return run
    },
    invokeManager: async ({ contextPack }) => {
      managerContexts.push(contextPack)
      const taskId = repository.listManagerTasks(run.id)[0]?.id
      if (!taskId) {
        throw new Error("task missing")
      }
      const nextProposal = proposal(taskId)
      managerInvocations += 1
      return JSON.stringify(nextProposal)
    },
    invokeAgent: async () => ({
      status: "completed",
      source: "simulated",
      body: "Worker evidence line 1\nWorker evidence line 2"
    }),
    listProjects: async () => [],
    listWorkflowRuns: async () => []
  })

  const task = await repository.createManagerTask({
    workflowRunId: run.id,
    title: "Check bridge persistence",
    instruction: "Run the outbound bridge verification.",
    successCriteria: ["Persist the worker result."],
    strategy: "task-2-check"
  })

  await services.scheduler.enqueue({
    workflowRunId: run.id,
    reason: "mission_created",
    idempotencyKey: "wake-dispatch"
  })
  await services.scheduler.runNext(run.id)

  const entriesAfterDispatch = repository.listConversation(run.id)
  const handoff = entriesAfterDispatch.find((entry) => entry.taskId === task.id && entry.agentId === "openclaw.rowlet")
  assert.ok(handoff)
  assert.equal(handoff.recipientAgent, "codex")
  assert.equal(handoff.status, "completed")
  assert.equal(handoff.content, "Worker evidence line 1\nWorker evidence line 2")
  assert.equal(handoff.idempotencyKey.includes(task.id), true)
  assert.equal(handoff.idempotencyKey.includes(":1"), true)

  const persistedArtifact = run.artifacts.find((artifact) => artifact.id === handoff.artifactIds[0])
  assert.ok(persistedArtifact)
  assert.equal(persistedArtifact?.body, "Worker evidence line 1\nWorker evidence line 2")

  const wakesAfterDispatch = repository.listManagerWakes(run.id)
  assert.equal(wakesAfterDispatch.some((wake) => wake.reason === "worker_completed" && wake.status === "pending"), true)

  await services.scheduler.runNext(run.id)

  const workerWakeContext = managerContexts[1]
  assert.ok(workerWakeContext)
  assert.match(workerWakeContext.text, /Worker evidence line 1/)
  assert.match(workerWakeContext.text, new RegExp(persistedArtifact!.id))
  assert.equal(workerWakeContext.conversationEntryIds.includes(handoff.id), true)
  assert.equal(workerWakeContext.artifactIds.includes(persistedArtifact!.id), true)
  assert.equal(run.status, "completed")

  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
})
