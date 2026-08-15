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

test("manager runtime persists an atomic checkpoint and resumes without chat history", async (t) => {
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
