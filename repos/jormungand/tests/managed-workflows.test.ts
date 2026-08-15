import assert from "node:assert/strict"
import test from "node:test"
import {
  arceusMaintenanceStages,
  createArceusMaintenanceConfig,
  createHiveMissionConfig,
  requiresHumanApproval
} from "../lib/managed-workflows"
import { getProjectTemplate, projectTypeOptions } from "../lib/project-templates"
import { createWorkflowRun } from "../lib/workflow"

test("Global mode exposes ten project types in the accepted order", () => {
  assert.deepEqual(projectTypeOptions.map((option) => option.type), [
    "research", "development", "testing", "documentation", "diagnosis",
    "decision", "llm_wiki_maintenance", "agent_task", "hive_mission",
    "arceus_maintenance"
  ])
  assert.deepEqual(getProjectTemplate("hive_mission").phases, [
    "Goal", "Plan", "Dispatch", "Monitor", "Verify", "Completed"
  ])
  assert.deepEqual(getProjectTemplate("arceus_maintenance").phases, arceusMaintenanceStages)
})

test("Hive Mission fixes Codex as manager and requires positive budgets", () => {
  const config = createHiveMissionConfig({
    successCriteria: ["Two worker types complete"],
    constraints: ["No external effects"],
    nonGoals: ["No production deploy"],
    repositoryScope: "owner/repo",
    budget: { callLimit: 10, timeLimitMs: 60000, costLimitUsd: 2 }
  })
  assert.equal(config.manager, "codex")
  assert.equal(config.approvalPolicy, "external_and_irreversible")
  assert.throws(() => createHiveMissionConfig({
    successCriteria: ["Complete"], constraints: [], nonGoals: [], repositoryScope: "owner/repo",
    budget: { callLimit: 0, timeLimitMs: 60000, costLimitUsd: 1 }
  }), /positive/i)
})

test("Arceus fixes target, executor, repository, and stage order", () => {
  const config = createArceusMaintenanceConfig({
    repository: "C:/work/jormungand",
    successCriteria: ["Tests pass"], constraints: [], nonGoals: []
  })
  assert.equal(config.target, "Jormungand")
  assert.equal(config.executor, "codex")
  assert.equal(config.repository, "C:/work/jormungand")
  assert.deepEqual(config.stages, ["Intake", "Plan", "Modify", "Test", "Code Review", "Ready"])
})

test("managed runs start under Codex control without changing existing workflows", () => {
  const run = createWorkflowRun({
    projectId: "project-1", projectName: "Hive", projectType: "hive_mission",
    repository: "owner/repo", requirement: "Coordinate workers", selectedAgent: "openclaw.gengar",
    designApprovalActor: "human", verificationApprovalActor: "human",
    managedConfig: createHiveMissionConfig({
      successCriteria: ["Complete"], constraints: [], nonGoals: [], repositoryScope: "owner/repo",
      budget: { callLimit: 5, timeLimitMs: 60000, costLimitUsd: 1 }
    })
  })
  assert.equal(run.selectedAgent, "codex")
  assert.equal(run.managed?.manager, "codex")
  assert.equal(run.managed?.budget.callLimit, 5)
})

test("external and irreversible effects always require human approval", () => {
  for (const effect of [
    "physical_delete", "protected_push", "merge", "production_deploy",
    "paid_operation", "external_message", "other_irreversible"
  ] as const) {
    assert.equal(requiresHumanApproval(effect), true)
  }
})
