import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createHiveManagerRuntime,
  parseManagerProposal,
  validateManagerProposal
} from "../lib/hive-manager"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import type { ManagerProposal } from "../lib/types"
import { createManagerScheduler } from "../lib/manager-scheduler"
import { createWorkflowRun } from "../lib/workflow"

function proposal(overrides: Partial<ManagerProposal> = {}): ManagerProposal {
  return {
    observation: "The mission needs an isolation test.",
    decision: "Create and dispatch one task.",
    reason: "Independent evidence is missing.",
    proposed_actions: [
      {
        type: "create_task",
        title: "Verify isolation",
        instruction: "Test project memory isolation.",
        successCriteria: ["Project B content remains hidden"],
        strategy: "integration-test"
      }
    ],
    memory_changes: [],
    approval_requests: [],
    next_wake_condition: "worker_completed",
    ...overrides
  }
}

test("manager parser accepts one JSON object and rejects unknown actions", () => {
  assert.deepEqual(parseManagerProposal(JSON.stringify(proposal())), proposal())
  assert.deepEqual(
    parseManagerProposal(JSON.stringify(proposal({
      proposed_actions: ["Run the focused conversation composer test."] as never
    }))).proposed_actions[0],
    {
      type: "create_task",
      title: "Manager-proposed task",
      instruction: "Run the focused conversation composer test.",
      successCriteria: ["Run the focused conversation composer test."],
      strategy: "manager-compat-string"
    }
  )
  assert.throws(
    () => parseManagerProposal(JSON.stringify(proposal({
      proposed_actions: [{ type: "raise_permissions", permission: "production.deploy" } as never]
    }))),
    /unknown manager action/i
  )
  assert.throws(() => parseManagerProposal("```json\n{}\n```"), /valid JSON object/i)
})

test("manager validator rejects escalation, scope, agent, and budget violations", () => {
  const checked = validateManagerProposal(proposal({
    proposed_actions: [
      { type: "dispatch_task", taskId: "other-mission-task", agentId: "openclaw.rowlet" },
      { type: "dispatch_task", taskId: "task-1", agentId: "openclaw.gengar" },
      { type: "request_approval", effect: "production_deploy", reason: "Release verified changes." }
    ]
  }), {
    workflowRunId: "run-1",
    missionTaskIds: ["task-1"],
    allowedAgents: ["codex", "openclaw.rowlet"],
    remainingCalls: 1,
    approvalRequiredEffects: ["production_deploy"]
  })

  assert.deepEqual(checked.acceptedActions.map((action) => action.type), ["request_approval"])
  assert.equal(checked.rejectedActions.length, 2)
  assert.match(checked.rejectedActions[0].reason, /mission scope/i)
  assert.match(checked.rejectedActions[1].reason, /not allowed/i)
})

test("manager runtime persists an atomic checkpoint and resumes without chat history", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-manager-"))
  const firstDatabase = openHiveDatabase({ dataDir })
  const firstRepository = createHiveMemoryRepository(firstDatabase)
  const runtime = createHiveManagerRuntime(firstRepository)
  const result = await runtime.checkpoint({
    workflowRunId: "run-1",
    proposal: proposal(),
    validation: {
      acceptedActions: proposal().proposed_actions,
      rejectedActions: []
    },
    checkpoint: {
      currentGoal: "Verify memory isolation",
      taskGraph: [],
      workerAssignments: [],
      blockers: [],
      risks: [],
      recentDecisions: ["Create isolation task"],
      pendingApprovals: [],
      memoryMutations: [],
      budget: {
        callLimit: 10,
        callsUsed: 1,
        timeLimitMs: 60000,
        startedAt: "2026-08-15T00:00:00.000Z",
        costLimitUsd: 1,
        costUsedUsd: 0.1
      },
      nextWakeCondition: "worker_completed"
    }
  })
  firstDatabase.close()

  const secondDatabase = openHiveDatabase({ dataDir })
  const resumed = createHiveManagerRuntime(createHiveMemoryRepository(secondDatabase))
    .resume("run-1")
  assert.equal(resumed?.id, result.id)
  assert.equal(resumed?.checkpoint.currentGoal, "Verify memory isolation")
  assert.equal(resumed?.cycle, 1)
  secondDatabase.close()
  await rm(dataDir, { recursive: true, force: true })
})

test("scheduler deduplicates wakes and accounts for one manager call", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-scheduler-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)
  let run = createWorkflowRun({
    projectId: "project-1", projectName: "Mission", repository: "owner/repo",
    requirement: "Verify memory isolation", selectedAgent: "codex",
    designApprovalActor: "human", verificationApprovalActor: "human"
  })
  run = {
    ...run,
    managed: {
      manager: "codex", state: "idle", checkpointId: undefined,
      taskCounts: { pending: 0, running: 0, completed: 0, failed: 0, stopped: 0 },
      budget: {
        callLimit: 3, callsUsed: 0, timeLimitMs: 60000,
        startedAt: new Date().toISOString(), costLimitUsd: 1, costUsedUsd: 0
      },
      circuitBreakerOpen: false
    }
  }
  let invocations = 0
  const scheduler = createManagerScheduler({
    repository,
    getRun: async () => run,
    saveRun: async (next) => { run = next; return next },
    invokeManager: async () => {
      invocations += 1
      return JSON.stringify(proposal({ proposed_actions: [] }))
    },
    allowedAgents: () => ["codex", "openclaw.rowlet"]
  })

  await scheduler.enqueue({ workflowRunId: run.id, reason: "mission_created", idempotencyKey: "wake-1" })
  await scheduler.enqueue({ workflowRunId: run.id, reason: "mission_created", idempotencyKey: "wake-1" })
  assert.equal(repository.listManagerWakes(run.id).length, 1)
  const result = await scheduler.runNext(run.id)
  assert.equal(result.status, "completed")
  assert.equal(invocations, 1)
  assert.equal(run.managed?.budget.callsUsed, 1)
  assert.equal((await scheduler.runNext(run.id)).status, "idle")
})

test("scheduler pauses before invoking manager when budget is exhausted", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-scheduler-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)
  let run = createWorkflowRun({
    projectId: "project-1", projectName: "Mission", repository: "owner/repo",
    requirement: "Verify memory isolation", selectedAgent: "codex",
    designApprovalActor: "human", verificationApprovalActor: "human"
  })
  run = {
    ...run,
    managed: {
      manager: "codex", state: "idle",
      taskCounts: { pending: 0, running: 0, completed: 0, failed: 0, stopped: 0 },
      budget: {
        callLimit: 1, callsUsed: 1, timeLimitMs: 60000,
        startedAt: new Date().toISOString(), costLimitUsd: 1, costUsedUsd: 0
      },
      circuitBreakerOpen: false
    }
  }
  const scheduler = createManagerScheduler({
    repository,
    getRun: async () => run,
    saveRun: async (next) => { run = next; return next },
    invokeManager: async () => { throw new Error("manager must not be invoked") },
    allowedAgents: () => ["codex"]
  })
  await scheduler.enqueue({ workflowRunId: run.id, reason: "health_check", idempotencyKey: "wake-budget" })
  const result = await scheduler.runNext(run.id)
  assert.deepEqual(result, { status: "paused", reason: "budget_exhausted" })
  assert.equal(run.managed?.state, "paused")
})

test("scheduler keeps approval actions in audit without pausing in full mode", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-scheduler-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)
  let run = createWorkflowRun({
    projectId: "project-1", projectName: "Mission", repository: "owner/repo",
    requirement: "Publish reviewed changes", selectedAgent: "codex",
    designApprovalActor: "human", verificationApprovalActor: "human"
  })
  run = {
    ...run,
    managed: {
      manager: "codex", state: "idle",
      taskCounts: { pending: 0, running: 0, completed: 0, failed: 0, stopped: 0 },
      budget: {
        callLimit: 3, callsUsed: 0, timeLimitMs: 60000,
        startedAt: new Date().toISOString(), costLimitUsd: 1, costUsedUsd: 0
      },
      circuitBreakerOpen: false
    }
  }
  let approvals = 0
  const scheduler = createManagerScheduler({
    repository,
    getRun: async () => run,
    saveRun: async (next) => { run = next; return next },
    invokeManager: async () => JSON.stringify(proposal({
      proposed_actions: [
        { type: "request_approval", effect: "protected_push", reason: "Publish reviewed changes." }
      ],
      approval_requests: [
        { effect: "protected_push", reason: "Publish reviewed changes." }
      ],
      next_wake_condition: "approval_decided"
    })),
    allowedAgents: () => ["codex"],
    requestApproval: async () => { approvals += 1 },
    permissionMode: "full"
  } as Parameters<typeof createManagerScheduler>[0])

  await scheduler.enqueue({ workflowRunId: run.id, reason: "mission_created", idempotencyKey: "wake-full" })
  const result = await scheduler.runNext(run.id)
  const checkpoint = repository.getLatestManagerCheckpoint(run.id)

  assert.equal(result.status, "completed")
  assert.equal(result.acceptedActionCount, 1)
  assert.equal(approvals, 0)
  assert.equal(run.status, "pending")
  assert.equal(run.managed?.state, "idle")
  assert.deepEqual(checkpoint?.checkpoint.pendingApprovals, [
    { effect: "protected_push", reason: "Publish reviewed changes." }
  ])
})
