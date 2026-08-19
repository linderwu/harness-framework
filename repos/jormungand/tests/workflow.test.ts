import assert from "node:assert/strict"
import test from "node:test"
import {
  advanceWorkflow,
  createWorkflowRun,
  decideApprovalGate,
  getDefaultSkillExecutor
} from "../lib/workflow"
import type { AgentPermissionMode } from "../lib/agent-permissions"
import type { RuntimeSkillResolver } from "../lib/workflow"
import type { ApprovalGate, WorkflowRun } from "../lib/types"

const runtimeSkillResolver: RuntimeSkillResolver = () => ({
    status: "completed",
    bundles: [
      {
        id: "superpowers-full",
        version: "1.0.0",
        sourceUrl:
          "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
        checksum: {
          algorithm: "sha256",
          value: "c9b1d3ece463869d22d8c560b50a3082e5dede290126b84c07461869b509ee8d"
        },
        required: true
      }
    ]
  })

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

async function advanceToPlanGate(
  run: WorkflowRun,
  permissionMode: AgentPermissionMode = "restricted"
) {
  let nextRun = await advanceRun(run, permissionMode)
  nextRun = await advanceRun(nextRun, permissionMode)
  nextRun = await advanceRun(nextRun, permissionMode)

  return nextRun
}

async function advanceToDesignGate(
  run: WorkflowRun,
  permissionMode: AgentPermissionMode = "restricted"
) {
  let nextRun = await advanceToPlanGate(run, permissionMode)
  const planGate = getPendingGate(nextRun, "plan")

  nextRun = decideApprovalGate(nextRun, planGate.id, "approved")
  return advanceRun(nextRun, permissionMode)
}

async function advanceToVerificationGate(
  run: WorkflowRun,
  permissionMode: AgentPermissionMode = "restricted"
) {
  let nextRun = await advanceToDesignGate(run, permissionMode)
  const designGate = getPendingGate(nextRun, "design")

  nextRun = decideApprovalGate(nextRun, designGate.id, "approved")
  nextRun = await advanceRun(nextRun, permissionMode)
  nextRun = await advanceRun(nextRun, permissionMode)
  nextRun = await advanceRun(nextRun, permissionMode)
  return advanceRun(nextRun, permissionMode)
}

function advanceRun(
  run: WorkflowRun,
  permissionMode: AgentPermissionMode = "restricted"
) {
  return advanceWorkflow(run, {
    resolveRuntimeSkillBundles: runtimeSkillResolver,
    permissionMode
  })
}

function getPendingGate(run: WorkflowRun, stage: ApprovalGate["stage"]) {
  const gate = [...run.approvalGates]
    .reverse()
    .find((item) => item.stage === stage && item.status === "pending")

  assert.ok(gate, `Expected a pending ${stage} approval gate`)
  return gate
}

test("design and verification approval policies are fixed to human", () => {
  const run = createRun()

  assert.deepEqual(
    run.approvalPolicies.map((policy) => [policy.stage, policy.actorType]),
    [
      ["plan", "human"],
      ["design", "human"],
      ["verification", "human"]
    ]
  )
})

test("human design approval remains pending until an explicit decision", async () => {
  const run = await advanceToDesignGate(createRun())

  const designGate = getPendingGate(run, "design")

  assert.equal(run.currentStage, "design")
  assert.equal(run.status, "waiting_for_approval")
  assert.equal(designGate.actorType, "human")
  assert.equal(designGate.status, "pending")
  assert.equal(designGate.decidedAt, undefined)
})

test("research prompt and execution default to Rowlet", () => {
  assert.equal(
    getDefaultSkillExecutor("research.prompt", "openclaw.charizard"),
    "openclaw.rowlet"
  )
  assert.equal(
    getDefaultSkillExecutor("research.execute", "openclaw.charizard"),
    "openclaw.rowlet"
  )
})

test("design changes requested creates a revised OpenSpec artifact and a new gate", async () => {
  let run = await advanceToDesignGate(createRun())
  const firstDesignGate = getPendingGate(run, "design")
  const firstDesignArtifact = run.artifacts.find(
    (artifact) => artifact.type === "openspec" && artifact.stage === "design"
  )

  assert.ok(firstDesignArtifact)

  run = decideApprovalGate(run, firstDesignGate.id, "changes_requested", "Clarify recovery behavior.")
  run = await advanceRun(run)

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
  run = await advanceRun(run)
  run = await advanceRun(run)

  const revisedPlanGate = getPendingGate(run, "plan")
  const plans = run.artifacts.filter(
    (artifact) => artifact.type === "plan" && artifact.stage === "plan"
  )

  assert.equal(plans.length, 2)
  assert.notEqual(revisedPlanGate.id, firstPlanGate.id)
  assert.ok(revisedPlanGate.revisionId)
})

test("human verification approval remains pending until an explicit decision", async () => {
  const run = await advanceToVerificationGate(createRun())

  const verificationGate = getPendingGate(run, "verification")

  assert.equal(run.currentStage, "verification")
  assert.equal(run.status, "waiting_for_approval")
  assert.equal(verificationGate.actorType, "human")
  assert.equal(verificationGate.status, "pending")
  assert.equal(verificationGate.decidedAt, undefined)
})

test("full mode bypasses plan and design approval gates", async () => {
  let run = createRun()

  run = await advanceRun(run, "full")
  run = await advanceRun(run, "full")
  run = await advanceRun(run, "full")

  assert.equal(run.currentStage, "design")
  assert.equal(run.status, "pending")
  assert.equal(run.approvalGates.length, 0)

  run = await advanceRun(run, "full")

  assert.equal(run.currentStage, "implementation")
  assert.equal(run.status, "pending")
  assert.equal(run.approvalGates.length, 0)
})

test("full mode completes verification without waiting for approval", async () => {
  let run = createRun()

  run = await advanceRun(run, "full")
  run = await advanceRun(run, "full")
  run = await advanceRun(run, "full")
  run = await advanceRun(run, "full")
  run = await advanceRun(run, "full")
  run = await advanceRun(run, "full")
  run = await advanceRun(run, "full")
  run = await advanceRun(run, "full")

  assert.equal(run.currentStage, "completed")
  assert.equal(run.status, "completed")
  assert.equal(run.approvalGates.length, 0)
  assert.equal(
    run.events.some(
      (event) =>
        event.eventType === "closeout" && event.status === "completed"
    ),
    true
  )
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
  run = await advanceRun(run)

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
