import { test } from "node:test"
import { strict as assert } from "node:assert"
import type { Project, WorkflowRun } from "../lib/types"
import {
  buildProjectSelectorItems,
  filterProjectSelectorItems,
  formatAbsoluteActivityTime,
  formatRelativeActivityTime,
  getProjectCompositeStatus
} from "../lib/project-selector"

function project(id: string, overrides: Partial<Project> = {}): Project {
  return {
    id,
    name: `${id} project`,
    type: "development",
    goal: "Ship useful work",
    status: "active",
    currentPhase: "Plan",
    nextAction: "Continue",
    repository: `${id}/repo`,
    source: "dashboard",
    contextFiles: [],
    artifactIds: [],
    workflowRunIds: [],
    createdAt: "2026-08-10T08:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    ...overrides
  }
}

function run(
  id: string,
  projectId: string,
  overrides: Partial<WorkflowRun> = {}
): WorkflowRun {
  return {
    schemaVersion: 3,
    version: 1,
    id,
    projectId,
    projectName: `${projectId} project`,
    repository: `${projectId}/repo`,
    requirement: "Run the workflow",
    contextFiles: [],
    source: "dashboard",
    currentStage: "plan",
    status: "running",
    selectedAgent: "codex",
    stageModes: {
      intake: "agent",
      plan: "agent",
      design: "agent",
      implementation: "agent",
      verification: "agent",
      completed: "manual"
    },
    skillAssignments: {},
    approvalPolicies: [],
    eventSkills: [],
    events: [],
    artifacts: [],
    approvalGates: [],
    agentRuns: [],
    revisions: [],
    eventLogStatus: "consistent",
    createdAt: "2026-08-10T08:30:00.000Z",
    updatedAt: "2026-08-10T10:00:00.000Z",
    ...overrides
  }
}

test("selector items sort by latest run activity first", () => {
  const items = buildProjectSelectorItems(
    [
      project("alpha", { updatedAt: "2026-08-10T12:00:00.000Z" }),
      project("bravo", { updatedAt: "2026-08-10T09:00:00.000Z" })
    ],
    [
      run("old-alpha-run", "alpha", {
        updatedAt: "2026-08-10T12:30:00.000Z"
      }),
      run("fresh-bravo-run", "bravo", {
        updatedAt: "2026-08-10T13:00:00.000Z"
      })
    ]
  )

  assert.deepEqual(
    items.map((item) => item.project.id),
    ["bravo", "alpha"]
  )
  assert.equal(items[0].latestRun?.id, "fresh-bravo-run")
})

test("projects without runs use project updatedAt for activity", () => {
  const [item] = buildProjectSelectorItems(
    [project("solo", { updatedAt: "2026-08-10T14:00:00.000Z" })],
    []
  )

  assert.equal(item.latestRun, undefined)
  assert.equal(item.activityAt, "2026-08-10T14:00:00.000Z")
  assert.equal(item.latestRunSummary, "No runs yet")
})

test("invalid activity timestamps sort last and show unknown activity", () => {
  const items = buildProjectSelectorItems(
    [
      project("broken", { updatedAt: "not-a-date" }),
      project("healthy", { updatedAt: "2026-08-10T15:00:00.000Z" })
    ],
    []
  )

  assert.deepEqual(
    items.map((item) => item.project.id),
    ["healthy", "broken"]
  )
  assert.equal(items[1].relativeActivityLabel, "Unknown activity")
})

test("composite status prioritizes needs attention over running", () => {
  const status = getProjectCompositeStatus(
    project("status"),
    [
      run("running", "status", { status: "running" }),
      run("failed", "status", { status: "failed" })
    ]
  )

  assert.equal(status.group, "needs_attention")
  assert.equal(status.label, "failed")
})

test("filters use coarse selector status groups", () => {
  const items = buildProjectSelectorItems(
    [
      project("active"),
      project("attention"),
      project("done", { status: "completed" })
    ],
    [run("attention-run", "attention", { status: "waiting_for_approval" })]
  )

  assert.deepEqual(
    filterProjectSelectorItems(items, "", "needs_attention").map(
      (item) => item.project.id
    ),
    ["attention"]
  )
  assert.deepEqual(
    filterProjectSelectorItems(items, "", "completed").map(
      (item) => item.project.id
    ),
    ["done"]
  )
})

test("search matches project name, repository, and type label", () => {
  const items = buildProjectSelectorItems(
    [
      project("docs", {
        name: "Reference Library",
        repository: "linder/reference",
        type: "documentation"
      }),
      project("qa", {
        name: "Regression Matrix",
        repository: "linder/quality",
        type: "testing"
      })
    ],
    []
  )

  assert.deepEqual(
    filterProjectSelectorItems(items, "reference", "all").map(
      (item) => item.project.id
    ),
    ["docs"]
  )
  assert.deepEqual(
    filterProjectSelectorItems(items, "quality", "all").map(
      (item) => item.project.id
    ),
    ["qa"]
  )
  assert.deepEqual(
    filterProjectSelectorItems(items, "Documentation", "all").map(
      (item) => item.project.id
    ),
    ["docs"]
  )
})

test("time formatting provides relative and absolute labels", () => {
  assert.equal(
    formatRelativeActivityTime(
      "2026-08-10T11:57:00.000Z",
      new Date("2026-08-10T12:00:00.000Z")
    ),
    "3 minutes ago"
  )
  assert.equal(
    formatAbsoluteActivityTime("2026-08-10T11:57:00.000Z"),
    "2026-08-10 11:57"
  )
})
