import assert from "node:assert/strict"
import test from "node:test"
import {
  getProjectTemplate,
  projectTypeOptions
} from "../lib/project-templates"
import {
  createProject,
  getProjectOverview,
  normalizeWorkspace
} from "../lib/workspace"
import { advanceWorkflow, createWorkflowRun } from "../lib/workflow"
import type { HarnessState, WorkflowRun } from "../lib/types"

function legacyRun(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    schemaVersion: 2,
    version: 1,
    id: overrides.id ?? "run-1",
    projectId: overrides.projectId ?? "",
    projectName: overrides.projectName ?? "Legacy Build",
    repository: overrides.repository ?? "owner/repo",
    requirement: overrides.requirement ?? "Ship the thing",
    contextFiles: overrides.contextFiles ?? [],
    source: overrides.source ?? "dashboard",
    sourceRef: overrides.sourceRef,
    currentStage: overrides.currentStage ?? "plan",
    status: overrides.status ?? "waiting_for_approval",
    selectedAgent: overrides.selectedAgent ?? "codex",
    stageModes: overrides.stageModes ?? {
      intake: "hybrid",
      plan: "hybrid",
      design: "hybrid",
      implementation: "hybrid",
      verification: "hybrid",
      completed: "manual"
    },
    skillAssignments: overrides.skillAssignments ?? {},
    approvalPolicies: overrides.approvalPolicies ?? [],
    eventSkills: overrides.eventSkills ?? [],
    events: overrides.events ?? [],
    artifacts: overrides.artifacts ?? [],
    approvalGates: overrides.approvalGates ?? [],
    agentRuns: overrides.agentRuns ?? [],
    revisions: overrides.revisions ?? [],
    eventLogStatus: overrides.eventLogStatus ?? "consistent",
    createdAt: overrides.createdAt ?? "2026-07-28T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-07-28T00:01:00.000Z"
  }
}

test("project templates expose project types with phase labels", () => {
  assert.deepEqual(
    projectTypeOptions.map((option) => option.type),
    [
      "research",
      "development",
      "testing",
      "documentation",
      "diagnosis",
      "decision",
      "agent_task"
    ]
  )

  assert.deepEqual(getProjectTemplate("research").phases, ["Brief", "Research Plan", "Evidence", "Synthesis", "Review", "Completed"])
  assert.deepEqual(getProjectTemplate("development").phases, ["Intake", "Plan", "Design", "Build", "Verify", "Completed"])
  assert.deepEqual(getProjectTemplate("testing").phases, ["Goal", "Test Plan", "Cases", "Execute", "Report", "Completed"])
  assert.deepEqual(getProjectTemplate("documentation").phases, ["Brief", "Outline", "Draft", "Review", "Publish", "Completed"])
  assert.deepEqual(getProjectTemplate("diagnosis").phases, ["Report", "Reproduce", "Diagnose", "Fix Plan", "Verify", "Completed"])
  assert.deepEqual(getProjectTemplate("decision").phases, ["Question", "Options", "Evidence", "Tradeoff", "Record", "Completed"])
  assert.deepEqual(getProjectTemplate("agent_task").phases, ["Instruction", "Response", "Completed"])
})

test("unknown project type falls back to development with a warning", () => {
  const result = getProjectTemplate("strange" as never)

  assert.equal(result.type, "development")
  assert.equal(result.warning, "Unknown project type \"strange\" normalized to development.")
})

test("existing state without projects normalizes into development projects", () => {
  const normalized = normalizeWorkspace({
    schemaVersion: 2,
    workflowRuns: [legacyRun()]
  } as HarnessState)

  assert.equal(normalized.projects.length, 1)
  assert.equal(normalized.projects[0].name, "Legacy Build")
  assert.equal(normalized.projects[0].type, "development")
  assert.equal(normalized.projects[0].goal, "Ship the thing")
  assert.equal(normalized.projects[0].repository, "owner/repo")
  assert.equal(normalized.projects[0].workflowRunIds[0], "run-1")
  assert.equal(normalized.workflowRuns[0].projectId, normalized.projects[0].id)
  assert.equal(normalized.warnings?.[0].code, "legacy_project_created")
})

test("new project creation applies template phase and default next action", () => {
  const project = createProject({
    name: "Decision Memo",
    type: "decision",
    goal: "Choose the database",
    repository: "",
    source: "dashboard",
    contextFiles: []
  })

  assert.equal(project.currentPhase, "Question")
  assert.equal(project.nextAction, "Frame the decision question.")
  assert.equal(project.status, "active")
  assert.deepEqual(project.artifactIds, [])
  assert.deepEqual(project.workflowRunIds, [])
})

test("project overview aggregates pending gates, artifacts, agent runs, and run status", () => {
  const project = createProject({
    name: "Testing Slice",
    type: "testing",
    goal: "Verify import flow",
    repository: "owner/repo",
    source: "dashboard",
    contextFiles: []
  })
  const run = legacyRun({
    id: "run-2",
    projectId: project.id,
    projectName: project.name,
    artifacts: [{ id: "artifact-1", workflowRunId: "run-2", stage: "plan", type: "test_report", title: "Report", body: "Evidence", createdAt: "2026-07-28T00:02:00.000Z" }],
    approvalGates: [{ id: "gate-1", workflowRunId: "run-2", stage: "verification", status: "pending", requestedBy: "system", actorType: "human", requireIndependence: false, createdAt: "2026-07-28T00:03:00.000Z" }],
    agentRuns: [{ id: "agent-run-1", workflowRunId: "run-2", stage: "verification", agent: "codex", status: "running", inputArtifactIds: [], outputArtifactIds: ["artifact-1"] }]
  })
  const overview = getProjectOverview(project, [run])

  assert.equal(overview.latestRun?.id, "run-2")
  assert.equal(overview.artifacts.length, 1)
  assert.equal(overview.pendingGates.length, 1)
  assert.equal(overview.agentRuns.length, 1)
  assert.deepEqual(overview.phaseLabels, ["Goal", "Test Plan", "Cases", "Execute", "Report", "Completed"])
})

test("normalization refreshes project summary and warns about artifact drift", () => {
  const project = createProject({
    name: "Development Slice",
    type: "development",
    goal: "Ship command center",
    repository: "owner/repo",
    source: "dashboard",
    contextFiles: []
  })
  const run = legacyRun({
    id: "run-3",
    projectId: project.id,
    projectName: project.name,
    status: "completed",
    currentStage: "completed",
    artifacts: [{ id: "artifact-3", workflowRunId: "run-3", stage: "completed", type: "log", title: "Closeout", body: "Done", createdAt: "2026-07-28T00:05:00.000Z" }],
    updatedAt: "2026-07-28T00:06:00.000Z"
  })

  const normalized = normalizeWorkspace({
    schemaVersion: 3,
    projects: [{ ...project, artifactIds: ["missing-artifact"] }],
    workflowRuns: [run]
  })

  assert.equal(normalized.projects[0].status, "completed")
  assert.equal(normalized.projects[0].currentPhase, "Completed")
  assert.deepEqual(normalized.projects[0].artifactIds, ["artifact-3"])
  assert.deepEqual(normalized.projects[0].workflowRunIds, ["run-3"])
  assert.equal(normalized.warnings?.some((warning) => warning.code === "missing_project_artifact_reference"), true)
})

test("workflow runs retain links to the selected project", () => {
  const project = createProject({
    name: "Research Slice",
    type: "research",
    goal: "Map the market",
    repository: "owner/research",
    source: "dashboard",
    contextFiles: []
  })
  const run = legacyRun({
    id: "run-4",
    projectName: project.name,
    repository: project.repository,
    requirement: project.goal,
    projectId: project.id
  })

  const normalized = normalizeWorkspace({
    schemaVersion: 3,
    projects: [project],
    workflowRuns: [run]
  })

  assert.equal(normalized.workflowRuns[0].projectId, project.id)
  assert.deepEqual(normalized.projects[0].workflowRunIds, ["run-4"])
})

test("createWorkflowRun requires and preserves the selected project id", () => {
  const project = createProject({
    name: "Decision Slice",
    type: "decision",
    goal: "Choose a queue",
    repository: "owner/decision",
    source: "dashboard",
    contextFiles: []
  })
  const run = createWorkflowRun({
    projectId: project.id,
    projectName: project.name,
    repository: project.repository,
    requirement: project.goal,
    contextFiles: project.contextFiles,
    selectedAgent: "codex",
    designApprovalActor: "independent_agent",
    verificationApprovalActor: "verification_subagent"
  })

  assert.equal(run.projectId, project.id)
  assert.equal(run.projectName, project.name)
  assert.equal(run.repository, project.repository)
  assert.equal(run.requirement, project.goal)
})

test("agent task workflow completes in one agent response without a repository", async () => {
  const project = createProject({
    name: "Summarize Notes",
    type: "agent_task",
    goal: "Summarize today's notes into actions.",
    repository: "",
    source: "dashboard",
    contextFiles: []
  })
  const run = createWorkflowRun({
    projectId: project.id,
    projectName: project.name,
    projectType: project.type,
    repository: project.repository,
    requirement: project.goal,
    contextFiles: project.contextFiles,
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })

  const completedRun = await advanceWorkflow(run, {
    invokeAgent: async () => ({
      status: "completed",
      source: "codex-bridge",
      body: "Action 1: follow up with the team."
    })
  })

  assert.equal(project.repository, "")
  assert.equal(run.repository, "")
  assert.equal(completedRun.status, "completed")
  assert.equal(completedRun.currentStage, "completed")
  assert.equal(completedRun.artifacts.length, 1)
  assert.equal(completedRun.artifacts[0].type, "log")
  assert.equal(completedRun.artifacts[0].title, "Agent Response")
  assert.equal(
    completedRun.artifacts[0].body,
    [
      "**Original Instruction**",
      "Summarize today's notes into actions.",
      "",
      "**Raw Agent Response**",
      "Action 1: follow up with the team.",
      "",
      "**Agent Response**",
      "Action 1: follow up with the team.",
      "",
      "**Closeout Status**",
      "complete"
    ].join("\n")
  )
  assert.equal(completedRun.approvalGates.length, 0)
})

test("default workflow event skills declare Superpowers for agent-executed development events", () => {
  const run = createWorkflowRun({
    projectId: "project-1",
    projectName: "Runtime Skills",
    repository: "linderwu/harness-framework",
    requirement: "Use Superpowers during agent execution.",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })

  const bundleBySkill = Object.fromEntries(
    run.eventSkills.map((skill) => [skill.id, skill.runtimeSkillBundles ?? []])
  )

  assert.deepEqual(bundleBySkill["plan.interview"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["plan.review"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["design.openspec"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["implementation.dispatch"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["implementation.code_review"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["verification.implementation_review"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["verification.generate"], ["superpowers-full"])
  assert.deepEqual(bundleBySkill["closeout.archive"], ["superpowers-full"])
})

test("default workflow event skills do not declare runtime bundles for intake or approval gates", () => {
  const run = createWorkflowRun({
    projectId: "project-1",
    projectName: "Runtime Skills",
    repository: "linderwu/harness-framework",
    requirement: "Use Superpowers during agent execution.",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })

  const bundleBySkill = Object.fromEntries(
    run.eventSkills.map((skill) => [skill.id, skill.runtimeSkillBundles ?? []])
  )

  assert.deepEqual(bundleBySkill["intake.requirement"], [])
  assert.deepEqual(bundleBySkill["plan.approval"], [])
  assert.deepEqual(bundleBySkill["design.approval"], [])
  assert.deepEqual(bundleBySkill["verification.approval"], [])
})

test("agent invocation receives resolved runtime skill bundle descriptors", async () => {
  const run = createWorkflowRun({
    projectId: "project-1",
    projectName: "Runtime Skills",
    repository: "linderwu/harness-framework",
    requirement: "Use Superpowers during planning.",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
  run.currentStage = "plan"

  const nextRun = await advanceWorkflow(run, {
    resolveRuntimeSkillBundles: () => ({
      status: "completed",
      bundles: [
        {
          id: "superpowers-full",
          version: "1.0.0",
          sourceUrl: "https://github.com/linderwu/harness-framework/releases/download/skills-v1.0.0/superpowers-full-1.0.0.tgz",
          checksum: {
            algorithm: "sha256",
            value: "c9b1d3ece463869d22d8c560b50a3082e5dede290126b84c07461869b509ee8d"
          },
          required: true
        }
      ]
    }),
    invokeAgent: async (input) => ({
      status: "completed",
      source: "codex-bridge",
      body: "Plan with Superpowers.",
      runtimeSkillBundleResults: [
        {
          id: "superpowers-full",
          version: "1.0.0",
          checksum: {
            algorithm: "sha256",
            value: "c9b1d3ece463869d22d8c560b50a3082e5dede290126b84c07461869b509ee8d"
          },
          downloadSource: "github-release",
          cacheStatus: "hit",
          verified: true,
          installedPath: "/agent/.harness/runtime-skills/superpowers-full/1.0.0"
        }
      ],
      statusMessage: `received ${input.runtimeSkillBundles?.length ?? 0} runtime bundle`
    })
  })

  assert.equal(nextRun.agentRuns[0].statusMessage?.includes("runtimeSkillBundleResults"), true)
  assert.equal(nextRun.events[0].note?.includes("runtimeSkillResolution"), true)
})

test("workflow fails before agent invocation when runtime skill resolution fails", async () => {
  const run = createWorkflowRun({
    projectId: "project-1",
    projectName: "Runtime Skills",
    repository: "linderwu/harness-framework",
    requirement: "Use Superpowers during planning.",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
  run.currentStage = "plan"
  let invoked = false

  const nextRun = await advanceWorkflow(run, {
    resolveRuntimeSkillBundles: () => ({
      status: "failed",
      errorCode: "bundle_not_locked",
      errorMessage: "Runtime skill bundle is not locked."
    }),
    invokeAgent: async () => {
      invoked = true
      return {
        status: "completed",
        source: "codex-bridge",
        body: "Should not run."
      }
    }
  })

  assert.equal(invoked, false)
  assert.equal(nextRun.status, "failed")
  assert.equal(nextRun.events[0].note?.includes("bundle_not_locked"), true)
})
