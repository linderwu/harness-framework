import assert from "node:assert/strict"
import test from "node:test"
import {
  advanceWorkflow,
  createWorkflowRun,
  decideApprovalGate
} from "../lib/workflow"
import type { ApprovalGate, WorkflowRun } from "../lib/types"

function createRun() {
  return createWorkflowRun({
    projectId: "project-1",
    projectName: "Workflow Safety",
    repository: "owner/repo",
    requirement: "Protect workflow approval and revision behavior.",
    selectedAgent: "codex",
    designApprovalActor: "independent_agent",
    verificationApprovalActor: "verification_subagent"
  })
}

async function advanceToPlanGate(run: WorkflowRun) {
  let nextRun = await advanceWorkflow(run)
  nextRun = await advanceWorkflow(nextRun)
  nextRun = await advanceWorkflow(nextRun)

  return nextRun
}

async function advanceToDesignGate(run: WorkflowRun) {
  let nextRun = await advanceToPlanGate(run)
  const planGate = getPendingGate(nextRun, "plan")

  nextRun = decideApprovalGate(nextRun, planGate.id, "approved")
  return advanceWorkflow(nextRun)
}

async function advanceToVerificationGate(run: WorkflowRun) {
  let nextRun = await advanceToDesignGate(run)
  const designGate = getPendingGate(nextRun, "design")

  nextRun = decideApprovalGate(nextRun, designGate.id, "approved")
  nextRun = await advanceWorkflow(nextRun)
  nextRun = await advanceWorkflow(nextRun)
  nextRun = await advanceWorkflow(nextRun)
  return advanceWorkflow(nextRun)
}

function getPendingGate(run: WorkflowRun, stage: ApprovalGate["stage"]) {
  const gate = [...run.approvalGates]
    .reverse()
    .find((item) => item.stage === stage && item.status === "pending")

  assert.ok(gate, `Expected a pending ${stage} approval gate`)
  return gate
}

test("non-human design approval remains pending until an explicit decision", async () => {
  const run = await advanceToDesignGate(createRun())

  const designGate = getPendingGate(run, "design")

  assert.equal(run.currentStage, "design")
  assert.equal(run.status, "waiting_for_approval")
  assert.equal(designGate.actorType, "independent_agent")
  assert.equal(designGate.status, "pending")
  assert.equal(designGate.decidedAt, undefined)
})

test("design changes requested creates a revised OpenSpec artifact and a new gate", async () => {
  let run = await advanceToDesignGate(createRun())
  const firstDesignGate = getPendingGate(run, "design")
  const firstDesignArtifact = run.artifacts.find(
    (artifact) => artifact.type === "openspec" && artifact.stage === "design"
  )

  assert.ok(firstDesignArtifact)

  run = decideApprovalGate(run, firstDesignGate.id, "changes_requested", "Clarify recovery behavior.")
  run = await advanceWorkflow(run)

  const revisedDesignGate = getPendingGate(run, "design")
  const designArtifacts = run.artifacts.filter(
    (artifact) => artifact.type === "openspec" && artifact.stage === "design"
  )

  assert.equal(run.currentStage, "design")
  assert.equal(run.status, "waiting_for_approval")
  assert.equal(designArtifacts.length, 2)
  assert.notEqual(revisedDesignGate.id, firstDesignGate.id)
  assert.ok(revisedDesignGate.revisionId)
  assert.equal(
    run.revisions.find((revision) => revision.id === revisedDesignGate.revisionId)
      ?.status,
    "resubmitted"
  )
})

test("plan changes requested creates a revised plan before reopening its gate", async () => {
  let run = await advanceToPlanGate(createRun())
  const firstPlanGate = getPendingGate(run, "plan")

  run = decideApprovalGate(run, firstPlanGate.id, "changes_requested", "Add success criteria.")
  run = await advanceWorkflow(run)
  run = await advanceWorkflow(run)

  const revisedPlanGate = getPendingGate(run, "plan")
  const plans = run.artifacts.filter(
    (artifact) => artifact.type === "plan" && artifact.stage === "plan"
  )

  assert.equal(plans.length, 2)
  assert.notEqual(revisedPlanGate.id, firstPlanGate.id)
  assert.ok(revisedPlanGate.revisionId)
})

test("non-human verification approval remains pending until an explicit decision", async () => {
  const run = await advanceToVerificationGate(createRun())

  const verificationGate = getPendingGate(run, "verification")

  assert.equal(run.currentStage, "verification")
  assert.equal(run.status, "waiting_for_approval")
  assert.equal(verificationGate.actorType, "verification_subagent")
  assert.equal(verificationGate.status, "pending")
  assert.equal(verificationGate.decidedAt, undefined)
})

test("verification changes requested creates a revised implementation artifact", async () => {
  let run = await advanceToVerificationGate(createRun())
  const verificationGate = getPendingGate(run, "verification")

  run = decideApprovalGate(
    run,
    verificationGate.id,
    "changes_requested",
    "Fix the failing acceptance scenario."
  )
  run = await advanceWorkflow(run)

  const patches = run.artifacts.filter(
    (artifact) => artifact.type === "patch" && artifact.stage === "implementation"
  )
  const activeRevision = run.revisions.find(
    (revision) => revision.targetStage === "implementation"
  )

  assert.equal(run.currentStage, "implementation")
  assert.equal(run.status, "pending")
  assert.equal(patches.length, 2)
  assert.equal(activeRevision?.status, "resubmitted")
})
