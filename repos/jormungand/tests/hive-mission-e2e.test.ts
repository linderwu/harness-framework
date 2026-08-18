import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createMemoryGovernance } from "../lib/hive-memory/governance"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import { createManagerScheduler } from "../lib/manager-scheduler"
import { createArceusMaintenanceConfig, createHiveMissionConfig } from "../lib/managed-workflows"
import type { AgentKind, ManagerProposal, WorkflowRun } from "../lib/types"
import { createWorkflowRun } from "../lib/workflow"
import { getHiveMemoryHealth } from "../lib/hive-health"

test("Hive Mission survives a runtime restart, uses two worker types, governs memory, and completes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-e2e-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  let run = createWorkflowRun({
    projectId: "project-e2e", projectName: "Hive E2E", projectType: "hive_mission",
    repository: "owner/repo", requirement: "Verify isolation with two workers", selectedAgent: "codex",
    designApprovalActor: "human", verificationApprovalActor: "human",
    managedConfig: createHiveMissionConfig({
      successCriteria: ["Rowlet and Gengar complete"], constraints: [], nonGoals: [],
      repositoryScope: "owner/repo", budget: { callLimit: 8, timeLimitMs: 600_000, costLimitUsd: 5 }
    })
  })
  const dispatched: string[] = []
  const saveRun = async (next: WorkflowRun) => (run = { ...next, version: run.version + 1 })
  const dependencies = {
    repository,
    getRun: async (id: string) => id === run.id ? run : undefined,
    saveRun,
    allowedAgents: () => ["codex", "openclaw.rowlet", "openclaw.gengar"] as AgentKind[],
    invokeManager: async () => JSON.stringify(managerProposal(repository.listManagerTasks(run.id))),
    dispatchWorker: async ({ agentId }: { agentId: string }) => {
      dispatched.push(agentId)
      return { status: "completed" as const, body: `${agentId} supplied evidence.` }
    }
  }
  const firstRuntime = createManagerScheduler(dependencies)
  await firstRuntime.enqueue({ workflowRunId: run.id, reason: "mission_created", idempotencyKey: "wake-1" })
  await firstRuntime.runNext(run.id)
  assert.equal(repository.listManagerTasks(run.id).length, 2)

  const restartedRuntime = createManagerScheduler(dependencies)
  await restartedRuntime.enqueue({ workflowRunId: run.id, reason: "mission_amended", idempotencyKey: "wake-2" })
  await restartedRuntime.runNext(run.id)
  assert.deepEqual(dispatched.sort(), ["openclaw.gengar", "openclaw.rowlet"])
  assert.equal(run.status, "completed")
  assert.equal(run.managed?.state, "completed")
  assert.equal(repository.getLatestManagerCheckpoint(run.id)?.cycle, 2)

  const candidate = await repository.submitCandidate({
    observation: "Project-scoped isolation checks passed with two independent workers.",
    proposedScope: "project", proposedScopeId: run.projectId, proposedKind: "episodic",
    confidence: 0.9, importance: 0.8, sourceAgent: "openclaw.rowlet",
    sensitivity: "internal", evidenceRefs: ["artifact:rowlet", "artifact:gengar"],
    sourceEventIds: ["worker:rowlet", "worker:gengar"],
    invalidationConditions: "A later isolation regression fails."
  })
  const promoted = await createMemoryGovernance(repository).promoteCandidate({ actor: "codex", candidateId: candidate.id })
  assert.equal(promoted.status, "activated")

  t.after(async () => { database.close(); await rm(dataDir, { recursive: true, force: true }) })
})

test("Arceus irreversible effects stop at human approval", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-arceus-e2e-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  let run = createWorkflowRun({
    projectId: "project-arceus", projectName: "Arceus", projectType: "arceus_maintenance",
    repository: "owner/jormungand", requirement: "Plan, modify, test, and review", selectedAgent: "codex",
    designApprovalActor: "human", verificationApprovalActor: "human",
    managedConfig: createArceusMaintenanceConfig({ repository: "owner/jormungand", successCriteria: ["Ready"], constraints: [], nonGoals: [] })
  })
  let approvals = 0
  const scheduler = createManagerScheduler({
    repository, getRun: async () => run,
    saveRun: async (next) => (run = { ...next, version: run.version + 1 }),
    allowedAgents: () => ["codex"],
    invokeManager: async () => JSON.stringify({
      observation: "Code review passed.", decision: "Request protected push approval.", reason: "Push is external.",
      proposed_actions: [{ type: "request_approval", effect: "protected_push", reason: "Publish reviewed changes." }],
      memory_changes: [], approval_requests: [{ effect: "protected_push", reason: "Publish reviewed changes." }],
      next_wake_condition: "approval_decided"
    } satisfies ManagerProposal),
    requestApproval: async () => { approvals += 1 },
    permissionMode: "restricted"
  } as Parameters<typeof createManagerScheduler>[0])
  await scheduler.enqueue({ workflowRunId: run.id, reason: "mission_created", idempotencyKey: "arceus-wake" })
  await scheduler.runNext(run.id)
  assert.equal(approvals, 1)
  assert.equal(run.status, "waiting_for_approval")
  assert.equal(run.managed?.state, "waiting_for_approval")
  t.after(async () => { database.close(); await rm(dataDir, { recursive: true, force: true }) })
})

test("Arceus full mode audits irreversible effects without entering approval wait", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-arceus-e2e-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  let run = createWorkflowRun({
    projectId: "project-arceus", projectName: "Arceus", projectType: "arceus_maintenance",
    repository: "owner/jormungand", requirement: "Plan, modify, test, and review", selectedAgent: "codex",
    designApprovalActor: "human", verificationApprovalActor: "human",
    managedConfig: createArceusMaintenanceConfig({ repository: "owner/jormungand", successCriteria: ["Ready"], constraints: [], nonGoals: [] })
  })
  let approvals = 0
  const scheduler = createManagerScheduler({
    repository, getRun: async () => run,
    saveRun: async (next) => (run = { ...next, version: run.version + 1 }),
    allowedAgents: () => ["codex"],
    invokeManager: async () => JSON.stringify({
      observation: "Code review passed.", decision: "Request protected push approval.", reason: "Push is external.",
      proposed_actions: [{ type: "request_approval", effect: "protected_push", reason: "Publish reviewed changes." }],
      memory_changes: [], approval_requests: [{ effect: "protected_push", reason: "Publish reviewed changes." }],
      next_wake_condition: "approval_decided"
    } satisfies ManagerProposal),
    requestApproval: async () => { approvals += 1 },
    permissionMode: "full"
  } as Parameters<typeof createManagerScheduler>[0])
  await scheduler.enqueue({ workflowRunId: run.id, reason: "mission_created", idempotencyKey: "arceus-full" })
  await scheduler.runNext(run.id)
  assert.equal(approvals, 0)
  assert.equal(run.status, "pending")
  assert.equal(run.managed?.state, "idle")
  assert.deepEqual(repository.getLatestManagerCheckpoint(run.id)?.checkpoint.pendingApprovals, [
    { effect: "protected_push", reason: "Publish reviewed changes." }
  ])
  t.after(async () => { database.close(); await rm(dataDir, { recursive: true, force: true }) })
})

test("unavailable Hive database fails closed before manager dispatch", async () => {
  const temp = await mkdtemp(join(tmpdir(), "jormungand-unavailable-"))
  const invalidDataDir = join(temp, "not-a-directory")
  await writeFile(invalidDataDir, "blocked")
  const database = openHiveDatabase({ dataDir: invalidDataDir })
  const repository = createHiveMemoryRepository(database)
  const invocations = 0
  await assert.rejects(() => repository.enqueueManagerWake({ workflowRunId: "run", reason: "mission_created", idempotencyKey: "wake" }), /unavailable/i)
  assert.equal(invocations, 0)
  database.close()
  await rm(temp, { recursive: true, force: true })
})

test("operator health is serializable and does not expose memory records", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-health-"))
  const database = openHiveDatabase({ dataDir })
  const health = await getHiveMemoryHealth(database)
  assert.equal(health.status, "ready")
  assert.equal(health.integrity, "ok")
  assert.equal(health.pathWithinConfiguredDataDir, false)
  assert.doesNotMatch(JSON.stringify(health), /content|secret_reference|connection/i)
  t.after(async () => { database.close(); await rm(dataDir, { recursive: true, force: true }) })
})

function managerProposal(tasks: ReturnType<ReturnType<typeof createHiveMemoryRepository>["listManagerTasks"]>): ManagerProposal {
  if (tasks.length === 0) return {
    observation: "Two independent checks are required.", decision: "Create Rowlet and Gengar tasks.", reason: "Diverse evidence reduces correlated failure.",
    proposed_actions: [
      { type: "create_task", title: "Rowlet isolation check", instruction: "Test project scope.", successCriteria: ["Isolation passes"], strategy: "rowlet-check" },
      { type: "create_task", title: "Gengar isolation check", instruction: "Test task scope.", successCriteria: ["Isolation passes"], strategy: "gengar-check" }
    ], memory_changes: [], approval_requests: [], next_wake_condition: "mission_amended"
  }
  return {
    observation: "Both tasks are ready.", decision: "Dispatch two worker types.", reason: "The task graph is bounded.",
    proposed_actions: [
      { type: "dispatch_task", taskId: tasks[0].id, agentId: "openclaw.rowlet" },
      { type: "dispatch_task", taskId: tasks[1].id, agentId: "openclaw.gengar" }
    ], memory_changes: [], approval_requests: [], next_wake_condition: "mission_completed"
  }
}
