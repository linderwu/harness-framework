# Personal Project Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn Jormungandr into a project-first personal command center with six project types, project creation, project overview, project-scoped workflow runs, and migrated legacy workflow state.

**Architecture:** Keep the existing workflow engine as the execution-record layer and add a workspace/project domain layer around it. Put template and aggregation logic in focused `lib` modules, keep filesystem persistence in `lib/store.ts`, and let the dashboard render projects first while continuing to reuse existing run controls and detail panels.

**Tech Stack:** Next.js 16 App Router, React 18, TypeScript, lucide-react, JSON-backed local state, Node built-in test runner with a temporary TypeScript compile step.

---

## Scope Check

The design spec covers one coherent vertical slice: workspace model, six project templates, project creation, project-first UI, run controls scoped to a selected project, and migration for existing run-only state. Later personal OS features such as global inbox, notes, calendar, people, source connections, and analytics are intentionally excluded from this plan.

## File Structure

- Create: `lib/project-templates.ts`
  Owns the six project type templates, labels, phase lists, default next actions, and unknown-type fallback warnings.

- Create: `lib/workspace.ts`
  Owns pure domain operations: create project, normalize workspace, create legacy projects from old runs, aggregate project overview, link runs to projects, and extend drift detection to project artifact references.

- Modify: `lib/types.ts`
  Keep existing project-related types, add `WorkspaceWarning`, `ProjectTemplate`, `ProjectOverview`, and optional `warnings` on `HarnessState`. Preserve the existing `WorkflowRun.projectId` field already present in this file.

- Modify: `lib/workflow.ts`
  Extend `createWorkflowRun` to accept `projectId` and keep legacy `projectName`, `repository`, `requirement`, and `contextFiles` copied from the selected project.

- Modify: `lib/store.ts`
  Persist and return full `HarnessState` with `projects`, `workflowRuns`, and warnings. Add project helpers and update workflow-run upserts so linked project summaries stay current.

- Create: `tests/workspace-model.test.ts`
  No-dependency domain tests compiled to `.tmp-tests` and run with `node --test`.

- Modify: `package.json`
  Add a no-dependency `test` script for the domain tests.

- Modify: `app/page.tsx`
  Load full workspace state instead of only runs.

- Modify: `app/api/projects/route.ts`
  Create and list projects.

- Modify: `app/api/projects/[id]/workflow-runs/route.ts`
  Start a workflow run for a selected project.

- Modify: `app/api/workflow-runs/route.ts`
  Keep legacy run creation working by creating or normalizing a backing development project.

- Modify: `app/api/workflow-runs/[id]/advance/route.ts`, `app/api/workflow-runs/[id]/stop/route.ts`, `app/api/workflow-runs/[id]/cancel/route.ts`, and `app/api/approval-gates/[id]/decide/route.ts`
  Continue returning the mutated run, while `upsertWorkflowRun` refreshes the linked project.

- Modify: `components/harness-dashboard.tsx`
  Change the main surface from run-first to project-first: left navigation and project list, new project creation, active project overview, template phase timeline, project artifact/gate/agent/context sections, and run controls scoped to the active project.

- Modify: `app/globals.css`
  Add project command center layout styles and keep existing class names where possible.

---

### Task 1: Add Project Templates and Domain Types

**Files:**
- Create: `lib/project-templates.ts`
- Modify: `lib/types.ts`
- Test: `tests/workspace-model.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Add the test script**

In `package.json`, add this script after `typecheck`:

```json
"test": "if exist .tmp-tests rmdir /s /q .tmp-tests && tsc tests/workspace-model.test.ts lib/project-templates.ts lib/workspace.ts --outDir .tmp-tests --module commonjs --target es2022 --moduleResolution node --esModuleInterop --skipLibCheck && node --test .tmp-tests/tests/workspace-model.test.js"
```

The scripts block should become:

```json
"scripts": {
  "dev": "next dev",
  "codex-bridge": "node scripts/codex-bridge.mjs",
  "build": "next build",
  "start": "next start",
  "lint": "eslint .",
  "typecheck": "tsc --noEmit",
  "test": "if exist .tmp-tests rmdir /s /q .tmp-tests && tsc tests/workspace-model.test.ts lib/project-templates.ts lib/workspace.ts --outDir .tmp-tests --module commonjs --target es2022 --moduleResolution node --esModuleInterop --skipLibCheck && node --test .tmp-tests/tests/workspace-model.test.js"
}
```

- [ ] **Step 2: Create the initial failing tests**

Create `tests/workspace-model.test.ts` with this content:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  getProjectTemplate,
  projectTypeOptions
} from "../lib/project-templates"

test("project templates expose all six project types with phase labels", () => {
  assert.deepEqual(
    projectTypeOptions.map((option) => option.type),
    [
      "research",
      "development",
      "testing",
      "documentation",
      "diagnosis",
      "decision"
    ]
  )

  assert.deepEqual(getProjectTemplate("research").phases, [
    "Brief",
    "Research Plan",
    "Evidence",
    "Synthesis",
    "Review",
    "Completed"
  ])
  assert.deepEqual(getProjectTemplate("development").phases, [
    "Intake",
    "Plan",
    "Design",
    "Build",
    "Verify",
    "Completed"
  ])
  assert.deepEqual(getProjectTemplate("testing").phases, [
    "Goal",
    "Test Plan",
    "Cases",
    "Execute",
    "Report",
    "Completed"
  ])
  assert.deepEqual(getProjectTemplate("documentation").phases, [
    "Brief",
    "Outline",
    "Draft",
    "Review",
    "Publish",
    "Completed"
  ])
  assert.deepEqual(getProjectTemplate("diagnosis").phases, [
    "Report",
    "Reproduce",
    "Diagnose",
    "Fix Plan",
    "Verify",
    "Completed"
  ])
  assert.deepEqual(getProjectTemplate("decision").phases, [
    "Question",
    "Options",
    "Evidence",
    "Tradeoff",
    "Record",
    "Completed"
  ])
})

test("unknown project type falls back to development with a warning", () => {
  const result = getProjectTemplate("strange" as never)

  assert.equal(result.type, "development")
  assert.equal(
    result.warning,
    "Unknown project type \"strange\" normalized to development."
  )
})
```

- [ ] **Step 3: Run the tests and confirm they fail**

Run:

```bash
npm test
```

Expected: FAIL because `lib/project-templates.ts` and `lib/workspace.ts` do not exist yet. The useful failure text is `Cannot find module '../lib/project-templates'`.

- [ ] **Step 4: Extend `lib/types.ts`**

Append these interfaces after the existing `Project` interface:

```ts
export interface ProjectTemplate {
  type: ProjectType
  label: string
  phases: string[]
  defaultArtifacts: ArtifactType[]
  creationPrompts: string[]
  defaultNextAction: string
  warning?: string
}

export interface ProjectOverview {
  project: Project
  phaseLabels: string[]
  artifacts: Artifact[]
  pendingGates: ApprovalGate[]
  agentRuns: AgentRun[]
  workflowEvents: WorkflowEvent[]
  contextFiles: ProjectContextFile[]
  latestRun?: WorkflowRun
  warning?: string
}

export interface WorkspaceWarning {
  code:
    | "legacy_project_created"
    | "unknown_project_type"
    | "missing_project_for_run"
    | "missing_project_artifact_reference"
  message: string
  projectId?: string
  workflowRunId?: string
  artifactId?: string
}
```

Then replace the existing `HarnessState` interface with:

```ts
export interface HarnessState {
  schemaVersion: number
  projects: Project[]
  workflowRuns: WorkflowRun[]
  warnings?: WorkspaceWarning[]
}
```

- [ ] **Step 5: Create `lib/project-templates.ts`**

```ts
import type { ProjectTemplate, ProjectType } from "./types"

export const projectTypeOptions: Array<{
  type: ProjectType
  label: string
}> = [
  { type: "research", label: "Research" },
  { type: "development", label: "Development" },
  { type: "testing", label: "Testing" },
  { type: "documentation", label: "Documentation" },
  { type: "diagnosis", label: "Diagnosis" },
  { type: "decision", label: "Decision" }
]

export const projectTemplates: Record<ProjectType, ProjectTemplate> = {
  research: {
    type: "research",
    label: "Research",
    phases: ["Brief", "Research Plan", "Evidence", "Synthesis", "Review", "Completed"],
    defaultArtifacts: ["requirement", "plan", "finding", "log"],
    creationPrompts: ["Research question", "Evidence sources", "Synthesis target"],
    defaultNextAction: "Clarify the research brief."
  },
  development: {
    type: "development",
    label: "Development",
    phases: ["Intake", "Plan", "Design", "Build", "Verify", "Completed"],
    defaultArtifacts: ["requirement", "plan", "openspec", "patch", "test_report"],
    creationPrompts: ["Feature or fix", "Repository", "Acceptance criteria"],
    defaultNextAction: "Capture the development intake."
  },
  testing: {
    type: "testing",
    label: "Testing",
    phases: ["Goal", "Test Plan", "Cases", "Execute", "Report", "Completed"],
    defaultArtifacts: ["requirement", "plan", "manual_checklist", "test_report"],
    creationPrompts: ["Test goal", "Risk areas", "Evidence to collect"],
    defaultNextAction: "Define the test goal."
  },
  documentation: {
    type: "documentation",
    label: "Documentation",
    phases: ["Brief", "Outline", "Draft", "Review", "Publish", "Completed"],
    defaultArtifacts: ["requirement", "plan", "design", "log"],
    creationPrompts: ["Audience", "Document goal", "Source material"],
    defaultNextAction: "Write the documentation brief."
  },
  diagnosis: {
    type: "diagnosis",
    label: "Diagnosis",
    phases: ["Report", "Reproduce", "Diagnose", "Fix Plan", "Verify", "Completed"],
    defaultArtifacts: ["requirement", "scenario_log", "finding", "plan", "test_report"],
    creationPrompts: ["Failure report", "Reproduction path", "Known constraints"],
    defaultNextAction: "Record the problem report."
  },
  decision: {
    type: "decision",
    label: "Decision",
    phases: ["Question", "Options", "Evidence", "Tradeoff", "Record", "Completed"],
    defaultArtifacts: ["requirement", "finding", "design", "log"],
    creationPrompts: ["Decision question", "Options", "Decision owner"],
    defaultNextAction: "Frame the decision question."
  }
}

export function getProjectTemplate(type: ProjectType): ProjectTemplate {
  if (type in projectTemplates) {
    return projectTemplates[type]
  }

  return {
    ...projectTemplates.development,
    warning: `Unknown project type "${String(type)}" normalized to development.`
  }
}
```

- [ ] **Step 6: Add a temporary empty workspace module for compilation**

Create `lib/workspace.ts` with:

```ts
export {}
```

- [ ] **Step 7: Run the focused test**

Run:

```bash
npm test
```

Expected: PASS with two passing tests.

- [ ] **Step 8: Commit**

```bash
git add package.json lib/types.ts lib/project-templates.ts lib/workspace.ts tests/workspace-model.test.ts
git commit -m "Add project type templates for command center

The workspace model needs a stable catalog of project phases before
persistence or UI can safely normalize project state.

Constraint: Keep the first slice dependency-free and use Node built-in tests
Confidence: high
Scope-risk: narrow
Tested: npm test
Not-tested: Next.js UI rendering"
```

---

### Task 2: Normalize Workspace State and Legacy Runs

**Files:**
- Modify: `lib/workspace.ts`
- Modify: `tests/workspace-model.test.ts`

- [ ] **Step 1: Add failing tests for workspace normalization**

Append this code to `tests/workspace-model.test.ts`:

```ts
import {
  createProject,
  getProjectOverview,
  normalizeWorkspace
} from "../lib/workspace"
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
    artifacts: [
      {
        id: "artifact-1",
        workflowRunId: "run-2",
        stage: "plan",
        type: "test_report",
        title: "Report",
        body: "Evidence",
        createdAt: "2026-07-28T00:02:00.000Z"
      }
    ],
    approvalGates: [
      {
        id: "gate-1",
        workflowRunId: "run-2",
        stage: "verification",
        status: "pending",
        requestedBy: "system",
        actorType: "human",
        requireIndependence: false,
        createdAt: "2026-07-28T00:03:00.000Z"
      }
    ],
    agentRuns: [
      {
        id: "agent-run-1",
        workflowRunId: "run-2",
        stage: "verification",
        agent: "codex",
        status: "running",
        inputArtifactIds: [],
        outputArtifactIds: ["artifact-1"]
      }
    ]
  })
  const overview = getProjectOverview(project, [run])

  assert.equal(overview.latestRun?.id, "run-2")
  assert.equal(overview.artifacts.length, 1)
  assert.equal(overview.pendingGates.length, 1)
  assert.equal(overview.agentRuns.length, 1)
  assert.deepEqual(overview.phaseLabels, [
    "Goal",
    "Test Plan",
    "Cases",
    "Execute",
    "Report",
    "Completed"
  ])
})
```

- [ ] **Step 2: Run tests and confirm they fail**

Run:

```bash
npm test
```

Expected: FAIL because `createProject`, `normalizeWorkspace`, and `getProjectOverview` are not exported from `lib/workspace.ts`.

- [ ] **Step 3: Implement `lib/workspace.ts`**

Replace `lib/workspace.ts` with:

```ts
import { getProjectTemplate } from "./project-templates"
import type {
  Artifact,
  HarnessState,
  Project,
  ProjectContextFile,
  ProjectOverview,
  ProjectStatus,
  ProjectType,
  WorkspaceWarning,
  WorkflowRun
} from "./types"

const workspaceSchemaVersion = 3

export interface CreateProjectInput {
  name: string
  type: ProjectType
  goal: string
  repository: string
  source: Project["source"]
  sourceRef?: string
  contextFiles?: ProjectContextFile[]
}

export function createProject(input: CreateProjectInput): Project {
  const template = getProjectTemplate(input.type)
  const now = new Date().toISOString()

  return {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    type: template.type,
    goal: input.goal.trim(),
    status: "active",
    currentPhase: template.phases[0],
    nextAction: template.defaultNextAction,
    repository: input.repository.trim(),
    source: input.source,
    sourceRef: input.sourceRef,
    contextFiles: input.contextFiles ?? [],
    artifactIds: [],
    workflowRunIds: [],
    createdAt: now,
    updatedAt: now
  }
}

export function normalizeWorkspace(state: Partial<HarnessState>): HarnessState {
  const warnings: WorkspaceWarning[] = [...(state.warnings ?? [])]
  const projects = [...(state.projects ?? [])]
  const workflowRuns = [...(state.workflowRuns ?? [])]
  const projectsById = new Map(projects.map((project) => [project.id, project]))

  const normalizedRuns = workflowRuns.map((run) => {
    if (run.projectId && projectsById.has(run.projectId)) {
      return run
    }

    const project = createLegacyProject(run)
    projects.push(project)
    projectsById.set(project.id, project)
    warnings.push({
      code: run.projectId ? "missing_project_for_run" : "legacy_project_created",
      message: run.projectId
        ? `Workflow run "${run.id}" referenced a missing project and was moved into a legacy development project.`
        : `Workflow run "${run.id}" was moved into a legacy development project.`,
      projectId: project.id,
      workflowRunId: run.id
    })

    return {
      ...run,
      projectId: project.id
    }
  })

  const refreshedProjects = projects.map((project) =>
    refreshProjectLinks(project, normalizedRuns, warnings)
  )

  return {
    schemaVersion: workspaceSchemaVersion,
    projects: refreshedProjects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    workflowRuns: normalizedRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    warnings
  }
}

export function getProjectOverview(
  project: Project,
  workflowRuns: WorkflowRun[]
): ProjectOverview {
  const projectRuns = workflowRuns
    .filter((run) => run.projectId === project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const artifacts = projectRuns.flatMap((run) => run.artifacts)
  const pendingGates = projectRuns.flatMap((run) =>
    run.approvalGates.filter((gate) => gate.status === "pending")
  )
  const agentRuns = projectRuns.flatMap((run) => run.agentRuns)
  const workflowEvents = projectRuns.flatMap((run) => run.events)
  const template = getProjectTemplate(project.type)

  return {
    project,
    phaseLabels: template.phases,
    artifacts,
    pendingGates,
    agentRuns,
    workflowEvents,
    contextFiles: project.contextFiles,
    latestRun: projectRuns[0],
    warning: template.warning
  }
}

export function refreshProjectAfterRun(
  project: Project,
  workflowRuns: WorkflowRun[]
): Project {
  return refreshProjectLinks(project, workflowRuns, [])
}

function createLegacyProject(run: WorkflowRun): Project {
  const now = run.updatedAt ?? new Date().toISOString()

  return {
    id: crypto.randomUUID(),
    name: run.projectName || "Legacy Workflow Run",
    type: "development",
    goal: run.requirement || "Continue legacy workflow run.",
    status: projectStatusFromRun(run.status),
    currentPhase: "Intake",
    nextAction: nextActionFromRun(run),
    repository: run.repository ?? "",
    source: run.source ?? "dashboard",
    sourceRef: run.sourceRef,
    contextFiles: run.contextFiles ?? [],
    artifactIds: run.artifacts.map((artifact) => artifact.id),
    workflowRunIds: [run.id],
    createdAt: run.createdAt ?? now,
    updatedAt: now
  }
}

function refreshProjectLinks(
  project: Project,
  workflowRuns: WorkflowRun[],
  warnings: WorkspaceWarning[]
): Project {
  const projectRuns = workflowRuns.filter((run) => run.projectId === project.id)
  const artifactIds = unique(projectRuns.flatMap((run) => run.artifacts.map((artifact) => artifact.id)))
  const runIds = unique(projectRuns.map((run) => run.id))
  const missingProjectArtifactIds = project.artifactIds.filter(
    (artifactId) => !artifactIds.includes(artifactId)
  )

  missingProjectArtifactIds.forEach((artifactId) => {
    warnings.push({
      code: "missing_project_artifact_reference",
      message: `Project "${project.id}" referenced missing artifact "${artifactId}".`,
      projectId: project.id,
      artifactId
    })
  })

  const latestRun = [...projectRuns].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]

  return {
    ...project,
    status: latestRun ? projectStatusFromRun(latestRun.status) : project.status,
    currentPhase: latestRun ? phaseFromRun(project.type, latestRun) : project.currentPhase,
    nextAction: latestRun ? nextActionFromRun(latestRun) : project.nextAction,
    artifactIds,
    workflowRunIds: runIds,
    updatedAt: latestRun?.updatedAt ?? project.updatedAt
  }
}

function phaseFromRun(projectType: ProjectType, run: WorkflowRun) {
  const template = getProjectTemplate(projectType)
  const developmentPhaseMap: Record<WorkflowRun["currentStage"], number> = {
    intake: 0,
    plan: 1,
    design: 2,
    implementation: 3,
    verification: 4,
    completed: 5
  }

  return template.phases[developmentPhaseMap[run.currentStage]] ?? template.phases[0]
}

function projectStatusFromRun(status: WorkflowRun["status"]): ProjectStatus {
  if (status === "waiting_for_approval") {
    return "waiting_for_approval"
  }

  if (
    status === "stopped" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "completed"
  ) {
    return status
  }

  return "active"
}

function nextActionFromRun(run: WorkflowRun) {
  if (run.status === "waiting_for_approval") {
    return "Review the pending approval gate."
  }

  if (run.status === "running") {
    return "Wait for the active run step to finish."
  }

  if (run.status === "completed") {
    return "Review final artifacts."
  }

  if (run.status === "failed") {
    return "Inspect the failed run and decide the recovery path."
  }

  if (run.status === "cancelled") {
    return "Review preserved artifacts from the cancelled run."
  }

  if (run.status === "stopped") {
    return "Resume or revise the stopped stage."
  }

  return "Advance the project run."
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}
```

- [ ] **Step 4: Run the focused test**

Run:

```bash
npm test
```

Expected: PASS with five passing tests.

- [ ] **Step 5: Commit**

```bash
git add lib/workspace.ts tests/workspace-model.test.ts
git commit -m "Normalize workflow runs into workspace projects

Legacy run-only state now gains durable development projects so the
command center can render projects as the primary entity without losing
existing workflow history.

Constraint: Existing JSON state must remain readable
Rejected: Rename workflow runs directly to projects | loses execution-record boundary
Confidence: high
Scope-risk: moderate
Tested: npm test
Not-tested: Filesystem store integration"
```

---

### Task 3: Persist Full Workspace State

**Files:**
- Modify: `lib/store.ts`
- Modify: `tests/workspace-model.test.ts`

- [ ] **Step 1: Add failing tests for project-link refresh**

Append this test to `tests/workspace-model.test.ts`:

```ts
test("normalization refreshes project artifact and workflow run links", () => {
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
    artifacts: [
      {
        id: "artifact-3",
        workflowRunId: "run-3",
        stage: "completed",
        type: "log",
        title: "Closeout",
        body: "Done",
        createdAt: "2026-07-28T00:05:00.000Z"
      }
    ],
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
  assert.equal(
    normalized.warnings?.some(
      (warning) => warning.code === "missing_project_artifact_reference"
    ),
    true
  )
})
```

- [ ] **Step 2: Run focused tests**

Run:

```bash
npm test
```

Expected: PASS. This test documents the state behavior before touching `lib/store.ts`.

- [ ] **Step 3: Modify `lib/store.ts` imports**

Replace the imports at the top of `lib/store.ts` with:

```ts
import { promises as fs } from "fs"
import path from "path"
import type { HarnessState, Project, WorkflowRun } from "@/lib/types"
import { normalizeAgentKind } from "@/lib/agents"
import { createDefaultEventSkills, getDefaultSkillExecutor } from "@/lib/workflow"
import { normalizeWorkspace, refreshProjectAfterRun } from "@/lib/workspace"
```

- [ ] **Step 4: Fix initial state creation**

Replace the `fs.writeFile` body in `ensureStateFile` with:

```ts
await fs.writeFile(
  statePath,
  JSON.stringify(
    { schemaVersion: 3, projects: [], workflowRuns: [] } satisfies HarnessState,
    null,
    2
  )
)
```

- [ ] **Step 5: Normalize full state in `readState`**

Replace `readState` with:

```ts
export async function readState(): Promise<HarnessState> {
  await ensureStateFile()
  const raw = await fs.readFile(statePath, "utf8")
  const state = JSON.parse(raw) as Partial<HarnessState>
  return normalizeWorkspace({
    ...state,
    workflowRuns: (state.workflowRuns ?? []).map(normalizeWorkflowRun)
  })
}
```

- [ ] **Step 6: Add project store helpers**

Insert these helpers after `writeState`:

```ts
export async function listProjects() {
  const state = await readState()
  return state.projects
}

export async function getProject(id: string) {
  const state = await readState()
  return state.projects.find((project) => project.id === id)
}

export async function upsertProject(nextProject: Project) {
  return withStateWrite(async () => {
    const state = await readState()
    const index = state.projects.findIndex((project) => project.id === nextProject.id)

    if (index >= 0) {
      state.projects[index] = nextProject
    } else {
      state.projects.push(nextProject)
    }

    const normalized = normalizeWorkspace(state)
    await writeState(normalized)
    return normalized.projects.find((project) => project.id === nextProject.id) ?? nextProject
  })
}
```

- [ ] **Step 7: Refresh projects from run mutations**

Inside `upsertWorkflowRun`, after the existing branch that pushes or replaces the run and before `await writeState(state)`, insert:

```ts
const linkedRun = state.workflowRuns.find((run) => run.id === nextRun.id)
const linkedProjectIndex = linkedRun
  ? state.projects.findIndex((project) => project.id === linkedRun.projectId)
  : -1

if (linkedRun && linkedProjectIndex >= 0) {
  state.projects[linkedProjectIndex] = refreshProjectAfterRun(
    state.projects[linkedProjectIndex],
    state.workflowRuns
  )
}

const normalizedState = normalizeWorkspace(state)
```

Then replace:

```ts
await writeState(state)
return state.workflowRuns.find((run) => run.id === nextRun.id) ?? nextRun
```

with:

```ts
await writeState(normalizedState)
return normalizedState.workflowRuns.find((run) => run.id === nextRun.id) ?? nextRun
```

- [ ] **Step 8: Preserve projects when deleting runs**

Replace the `writeState` call in `deleteWorkflowRun` with:

```ts
await writeState(normalizeWorkspace({ ...state, workflowRuns: nextRuns }))
```

- [ ] **Step 9: Run verification**

Run:

```bash
npm test
npm run typecheck
npm run lint
```

Expected:

- `npm test`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS

- [ ] **Step 10: Commit**

```bash
git add lib/store.ts tests/workspace-model.test.ts
git commit -m "Persist workspace projects alongside workflow runs

The store now reads and writes a full workspace document while keeping
legacy run-only files readable through normalization.

Constraint: Existing stale mutation version behavior must remain intact
Confidence: high
Scope-risk: moderate
Tested: npm test; npm run typecheck; npm run lint
Not-tested: Browser create-project flow"
```

---

### Task 4: Create Project-Scoped Workflow Runs

**Files:**
- Modify: `lib/workflow.ts`
- Modify: `lib/workspace.ts`
- Modify: `tests/workspace-model.test.ts`

- [ ] **Step 1: Add failing test for run linking**

Append this test to `tests/workspace-model.test.ts`:

```ts
test("starting a run links it to the selected project", async () => {
  const project = createProject({
    name: "Research Slice",
    type: "research",
    goal: "Map the market",
    repository: "owner/research",
    source: "dashboard",
    contextFiles: []
  })
  const { createWorkflowRun } = await import("../lib/workflow")
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
  assert.equal(run.projectName, "Research Slice")
  assert.equal(run.requirement, "Map the market")
})
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
npm test
```

Expected: FAIL because `createWorkflowRun` does not accept or return `projectId` yet.

- [ ] **Step 3: Modify `createWorkflowRun` input in `lib/workflow.ts`**

At the start of `createWorkflowRun(input: { ... })`, add this property to the input type:

```ts
projectId: string
```

Then add this field to the returned run object directly before `projectName`:

```ts
projectId: input.projectId,
```

- [ ] **Step 4: Run verification**

Run:

```bash
npm test
npm run typecheck
```

Expected:

- `npm test`: PASS
- `npm run typecheck`: FAIL until API callers pass `projectId`. The expected error references `app/api/workflow-runs/route.ts`.

- [ ] **Step 5: Commit only after API callers are fixed in Task 5**

Do not commit at this point because the app is intentionally between type-safe states.

---

### Task 5: Add Project APIs and Keep Legacy Run API Working

**Files:**
- Create: `app/api/projects/route.ts`
- Create: `app/api/projects/[id]/workflow-runs/route.ts`
- Modify: `app/api/workflow-runs/route.ts`
- Modify: `app/api/workflow-runs/[id]/advance/route.ts`
- Modify: `app/api/workflow-runs/[id]/stop/route.ts`
- Modify: `app/api/workflow-runs/[id]/cancel/route.ts`
- Modify: `app/api/approval-gates/[id]/decide/route.ts`

- [ ] **Step 1: Create `app/api/projects/route.ts`**

```ts
import { NextResponse } from "next/server"
import { createProject } from "@/lib/workspace"
import { listProjects, upsertProject } from "@/lib/store"
import type { ProjectContextFile, ProjectType } from "@/lib/types"

export async function GET() {
  return NextResponse.json(await listProjects())
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string
    type?: ProjectType
    goal?: string
    repository?: string
    sourceRef?: string
    contextFiles?: ProjectContextFile[]
  }

  if (!body.name || !body.goal || !body.type) {
    return NextResponse.json(
      { error: "name, type, and goal are required" },
      { status: 400 }
    )
  }

  const project = createProject({
    name: body.name,
    type: body.type,
    goal: body.goal,
    repository: body.repository ?? "",
    source: "dashboard",
    sourceRef: body.sourceRef,
    contextFiles: Array.isArray(body.contextFiles) ? body.contextFiles : []
  })

  return NextResponse.json(await upsertProject(project), { status: 201 })
}
```

- [ ] **Step 2: Create `app/api/projects/[id]/workflow-runs/route.ts`**

```ts
import { NextResponse } from "next/server"
import { invokeConfiguredAgent } from "@/lib/agent-bridge"
import { defaultAgentKind, normalizeAgentKind } from "@/lib/agents"
import { getProject, upsertWorkflowRun } from "@/lib/store"
import { advanceWorkflow, createWorkflowRun } from "@/lib/workflow"
import type { AgentKind, ApprovalActorType } from "@/lib/types"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const project = await getProject(id)

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const body = (await request.json()) as {
    selectedAgent?: AgentKind
    skillAssignments?: Record<string, AgentKind>
    designApprovalActor?: ApprovalActorType
    verificationApprovalActor?: ApprovalActorType
  }

  const run = createWorkflowRun({
    projectId: project.id,
    projectName: project.name,
    repository: project.repository,
    requirement: project.goal,
    contextFiles: project.contextFiles,
    selectedAgent: normalizeAgentKind(body.selectedAgent ?? defaultAgentKind),
    skillAssignments: body.skillAssignments,
    designApprovalActor: body.designApprovalActor ?? "independent_agent",
    verificationApprovalActor:
      body.verificationApprovalActor ?? "verification_subagent"
  })
  const intakeRun = await advanceWorkflow(run, {
    invokeAgent: invokeConfiguredAgent
  })

  await upsertWorkflowRun(intakeRun)
  return NextResponse.json(intakeRun, { status: 201 })
}
```

- [ ] **Step 3: Update legacy `app/api/workflow-runs/route.ts`**

Add imports:

```ts
import { createProject } from "@/lib/workspace"
import { upsertProject } from "@/lib/store"
```

Before `const run = createWorkflowRun({`, insert:

```ts
const project = await upsertProject(
  createProject({
    name: body.projectName,
    type: "development",
    goal: body.requirement,
    repository: body.repository ?? "",
    source: "dashboard",
    contextFiles
  })
)
```

Then add the project id to the `createWorkflowRun` call:

```ts
projectId: project.id,
```

- [ ] **Step 4: Confirm workflow mutation routes need no API shape changes**

Open these files and verify they still call `upsertWorkflowRun`, because project refresh now happens in the store:

```bash
rg -n "upsertWorkflowRun" app/api/workflow-runs app/api/approval-gates
```

Expected output includes:

```text
app/api/workflow-runs/[id]/advance/route.ts
app/api/workflow-runs/[id]/stop/route.ts
app/api/workflow-runs/[id]/cancel/route.ts
app/api/approval-gates/[id]/decide/route.ts
app/api/workflow-runs/route.ts
```

- [ ] **Step 5: Run verification**

Run:

```bash
npm test
npm run typecheck
npm run lint
```

Expected: all commands PASS.

- [ ] **Step 6: Commit**

```bash
git add lib/workflow.ts app/api/projects/route.ts app/api/projects/[id]/workflow-runs/route.ts app/api/workflow-runs/route.ts
git commit -m "Start workflow runs from durable projects

Project-scoped run creation establishes projects as the command surface
while preserving the legacy run creation endpoint as a development
project compatibility path.

Constraint: Existing dashboard POST /api/workflow-runs must keep working
Rejected: Break the old route immediately | unnecessary migration cliff for current UI
Confidence: high
Scope-risk: moderate
Tested: npm test; npm run typecheck; npm run lint
Not-tested: Browser project creation"
```

---

### Task 6: Load Workspace State Into the Dashboard

**Files:**
- Modify: `app/page.tsx`
- Modify: `components/harness-dashboard.tsx`

- [ ] **Step 1: Modify `app/page.tsx`**

Replace the file with:

```tsx
import { HarnessDashboard } from "@/components/harness-dashboard"
import { readState } from "@/lib/store"

export const dynamic = "force-dynamic"

export default async function Home() {
  const initialState = await readState()

  return <HarnessDashboard initialState={initialState} />
}
```

- [ ] **Step 2: Update dashboard type imports**

In `components/harness-dashboard.tsx`, add these imported types:

```ts
HarnessState,
Project,
ProjectOverview,
ProjectType
```

The type import block should include:

```ts
import type {
  AgentKind,
  ApprovalActorType,
  ApprovalGate,
  HarnessState,
  Project,
  ProjectContextFile,
  ProjectOverview,
  ProjectType,
  WorkflowRun,
  WorkflowStage
} from "@/lib/types"
```

- [ ] **Step 3: Import project helpers**

Add this import near the existing workflow imports:

```ts
import {
  getProjectTemplate,
  projectTypeOptions
} from "@/lib/project-templates"
```

- [ ] **Step 4: Replace dashboard props and top-level state**

Replace:

```ts
export function HarnessDashboard({
  initialRuns
}: {
  initialRuns: WorkflowRun[]
}) {
  const [runs, setRuns] = useState<WorkflowRun[]>(initialRuns)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    initialRuns[0]?.id
  )
```

with:

```ts
export function HarnessDashboard({
  initialState
}: {
  initialState: HarnessState
}) {
  const [workspaceState, setWorkspaceState] = useState<HarnessState>(initialState)
  const runs = workspaceState.workflowRuns
  const projects = workspaceState.projects
  const [selectedProjectId, setSelectedProjectId] = useState<string | undefined>(
    initialState.projects[0]?.id
  )
  const selectedProject = useMemo(
    () =>
      projects.find((project) => project.id === selectedProjectId) ??
      projects[0],
    [projects, selectedProjectId]
  )
  const projectRuns = useMemo(
    () =>
      selectedProject
        ? runs.filter((run) => run.projectId === selectedProject.id)
        : [],
    [runs, selectedProject]
  )
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    projectRuns[0]?.id
  )
```

After the existing `selectedRun` memo, add:

```ts
  const selectedOverview = useMemo(
    () => (selectedProject ? buildProjectOverview(selectedProject, projectRuns) : undefined),
    [selectedProject, projectRuns]
  )
```

- [ ] **Step 5: Add a project creation form state**

Replace the existing `form` state initial value with:

```ts
  const [form, setForm] = useState({
    projectType: "development" as ProjectType,
    projectName: "Jormungandr MVP",
    repository: "",
    requirement: sampleRequirement,
    contextFiles: [] as ProjectContextFile[],
    selectedAgent: defaultAgentKind,
    skillAssignments: defaultSkillAssignments,
    designApprovalActor: "independent_agent" as ApprovalActorType,
    verificationApprovalActor: "verification_subagent" as ApprovalActorType
  })
```

- [ ] **Step 6: Replace `refreshRuns` with workspace refresh**

Replace `refreshRuns` with:

```ts
  async function refreshWorkspace() {
    const [projectsResponse, runsResponse] = await Promise.all([
      fetch("/api/projects", { cache: "no-store" }),
      fetch("/api/workflow-runs", { cache: "no-store" })
    ])
    const [nextProjects, nextRuns] = (await Promise.all([
      projectsResponse.json(),
      runsResponse.json()
    ])) as [Project[], WorkflowRun[]]
    setWorkspaceState((current) => ({
      ...current,
      projects: nextProjects,
      workflowRuns: nextRuns
    }))
    setSelectedProjectId((current) =>
      nextProjects.some((project) => project.id === current)
        ? current
        : nextProjects[0]?.id
    )
    setIsLoading(false)
  }
```

Then replace calls to `refreshRuns()` with `refreshWorkspace()`.

- [ ] **Step 7: Replace create-run submission with create-project submission**

Replace `createRun` with:

```ts
  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsMutating(true)
    setMutationError(undefined)

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.projectName,
          type: form.projectType,
          goal: form.requirement,
          repository: form.repository,
          contextFiles: form.contextFiles
        })
      })
      const project = await readProjectMutationResponse(response)
      await refreshWorkspace()
      setSelectedProjectId(project.id)
      setSelectedRunId(undefined)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsMutating(false)
    }
  }
```

Add this helper after `readRunMutationResponse`:

```ts
  async function readProjectMutationResponse(response: Response) {
    const data = (await response.json()) as Project | { error?: string }

    if (response.ok) {
      return data as Project
    }

    throw new Error(("error" in data && data.error) || "Project mutation failed")
  }
```

- [ ] **Step 8: Add project-scoped start run function**

Add this function after `createProject`:

```ts
  async function startProjectRun(project: Project) {
    setIsMutating(true)
    setMutationError(undefined)

    try {
      const response = await fetch(`/api/projects/${project.id}/workflow-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedAgent: form.selectedAgent,
          skillAssignments: form.skillAssignments,
          designApprovalActor: form.designApprovalActor,
          verificationApprovalActor: form.verificationApprovalActor
        })
      })
      const run = await readRunMutationResponse(response)
      await refreshWorkspace()
      setSelectedProjectId(project.id)
      setSelectedRunId(run.id)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsMutating(false)
    }
  }
```

- [ ] **Step 9: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: FAIL until the JSX below is updated to use `createProject`, `projects`, and `selectedOverview`.

---

### Task 7: Build the Project-First UI Slice

**Files:**
- Modify: `components/harness-dashboard.tsx`
- Modify: `app/globals.css`

- [ ] **Step 1: Rename product labels in the shell**

In `components/harness-dashboard.tsx`, replace:

```tsx
<p className="eyebrow">Agentic Delivery System</p>
<h1>Jormungandr</h1>
```

with:

```tsx
<p className="eyebrow">Personal Project Command Center</p>
<h1>Jormungandr</h1>
```

Replace the refresh button handler:

```tsx
<button className="iconButton" onClick={refreshRuns} title="Refresh">
```

with:

```tsx
<button className="iconButton" onClick={refreshWorkspace} title="Refresh">
```

- [ ] **Step 2: Change the compose form to New Project**

Replace:

```tsx
<form className="panel composePanel" onSubmit={createRun}>
```

with:

```tsx
<form className="panel composePanel" onSubmit={createProject}>
```

Replace:

```tsx
<h2>New Workflow Run</h2>
```

with:

```tsx
<h2>New Project</h2>
```

Inside the requirement compose sheet, insert this label before the existing Project name label:

```tsx
<label>
  <span>Project Type</span>
  <select
    className="plainSelect"
    value={form.projectType}
    onChange={(event) => {
      const projectType = event.target.value as ProjectType
      const template = getProjectTemplate(projectType)
      setForm({ ...form, projectType })
      setBulkStage("all")
      setMutationError(template.warning)
    }}
  >
    {projectTypeOptions.map((option) => (
      <option key={option.type} value={option.type}>
        {option.label}
      </option>
    ))}
  </select>
</label>
```

Replace button text:

```tsx
Create Run
```

with:

```tsx
Create Project
```

- [ ] **Step 3: Replace the run list panel with a project list panel**

Replace the panel beginning with:

```tsx
<div className="panel runsPanel">
```

and ending before the selected detail conditional with:

```tsx
<div className="panel runsPanel">
  <div className="panelHeader">
    <GitBranch size={18} />
    <h2>Projects</h2>
  </div>
  {isLoading ? (
    <p className="muted">Loading</p>
  ) : projects.length === 0 ? (
    <p className="muted">No projects yet</p>
  ) : (
    <div className="runList">
      {projects.map((project) => (
        <button
          key={project.id}
          className={
            project.id === selectedProject?.id ? "runRow active" : "runRow"
          }
          onClick={() => {
            setSelectedProjectId(project.id)
            setSelectedRunId(
              runs.find((run) => run.projectId === project.id)?.id
            )
          }}
        >
          <span>{project.name}</span>
          <small>
            {getProjectTemplate(project.type).label} - {project.status}
          </small>
        </button>
      ))}
    </div>
  )}
</div>
```

- [ ] **Step 4: Replace the detail conditional**

Replace:

```tsx
{selectedRun ? (
  <RunDetail
    run={selectedRun}
    isMutating={isMutating}
    onAdvance={advanceRun}
    onDecideGate={decideGate}
  />
) : (
  <div className="panel emptyState">
    <Bot size={22} />
    <p>Create a workflow run to start.</p>
  </div>
)}
```

with:

```tsx
{selectedProject && selectedOverview ? (
  <ProjectDetail
    overview={selectedOverview}
    selectedRun={selectedRun}
    isMutating={isMutating}
    onStartRun={startProjectRun}
    onAdvance={advanceRun}
    onDecideGate={decideGate}
  />
) : (
  <div className="panel emptyState">
    <Bot size={22} />
    <p>Create a project to start.</p>
  </div>
)}
```

- [ ] **Step 5: Add local overview builder**

Add this function before `RunDetail`:

```tsx
function buildProjectOverview(
  project: Project,
  workflowRuns: WorkflowRun[]
): ProjectOverview {
  const template = getProjectTemplate(project.type)
  const sortedRuns = [...workflowRuns].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )

  return {
    project,
    phaseLabels: template.phases,
    artifacts: sortedRuns.flatMap((run) => run.artifacts),
    pendingGates: sortedRuns.flatMap((run) =>
      run.approvalGates.filter((gate) => gate.status === "pending")
    ),
    agentRuns: sortedRuns.flatMap((run) => run.agentRuns),
    workflowEvents: sortedRuns.flatMap((run) => run.events),
    contextFiles: project.contextFiles,
    latestRun: sortedRuns[0],
    warning: template.warning
  }
}
```

- [ ] **Step 6: Add `ProjectDetail` above `RunDetail`**

```tsx
function ProjectDetail({
  overview,
  selectedRun,
  isMutating,
  onStartRun,
  onAdvance,
  onDecideGate
}: {
  overview: ProjectOverview
  selectedRun?: WorkflowRun
  isMutating: boolean
  onStartRun: (project: Project) => void
  onAdvance: (runId: string) => void
  onDecideGate: (
    gate: ApprovalGate,
    decision: "approved" | "rejected" | "changes_requested"
  ) => void
}) {
  const { project } = overview

  return (
    <div className="detailStack">
      <section className="panel heroPanel">
        <div>
          <p className="eyebrow">
            {getProjectTemplate(project.type).label} - {project.repository || "No repository"}
          </p>
          <h2>{project.name}</h2>
          <p className="requirement">{project.goal}</p>
          <p className="muted">
            {project.currentPhase} - {project.status} - {project.nextAction}
          </p>
          {overview.warning ? <p className="muted">{overview.warning}</p> : null}
        </div>
        <div className="projectActionStack">
          <button
            className="primaryButton"
            disabled={isMutating}
            onClick={() => onStartRun(project)}
            title="Start project run"
          >
            <Play size={18} />
            Start Run
          </button>
          {selectedRun ? (
            <button
              className="iconTextButton"
              disabled={
                isMutating ||
                selectedRun.status === "waiting_for_approval" ||
                isTerminalStatus(selectedRun.status)
              }
              onClick={() => onAdvance(selectedRun.id)}
              title="Advance selected project run"
            >
              <ChevronRight size={18} />
              Advance
            </button>
          ) : null}
        </div>
      </section>

      <ProjectPhaseTimeline overview={overview} />

      <section className="splitGrid">
        <div className="panel">
          <div className="panelHeader">
            <ShieldCheck size={18} />
            <h2>Command Queue</h2>
          </div>
          {overview.pendingGates.length === 0 ? (
            <p className="muted">No pending gates</p>
          ) : (
            <div className="gateList">
              {overview.pendingGates.map((gate) => (
                <div className="gateRow" key={gate.id}>
                  <div>
                    <strong>{stageLabels[gate.stage]}</strong>
                    <small>
                      {actorLabels[gate.actorType]}
                      {gate.requireIndependence ? " - independent" : ""}
                    </small>
                  </div>
                  <div className="gateActions compact">
                    <button
                      className="iconTextButton approve"
                      onClick={() => onDecideGate(gate, "approved")}
                    >
                      <Check size={16} />
                      Approve
                    </button>
                    <button
                      className="iconTextButton request"
                      onClick={() => onDecideGate(gate, "changes_requested")}
                    >
                      <RefreshCw size={16} />
                      Changes
                    </button>
                    <button
                      className="iconTextButton reject"
                      onClick={() => onDecideGate(gate, "rejected")}
                    >
                      <X size={16} />
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panelHeader">
            <UserCheck size={18} />
            <h2>Context</h2>
          </div>
          {overview.contextFiles.length === 0 ? (
            <p className="muted">No context files attached</p>
          ) : (
            <div className="contextFileList">
              {overview.contextFiles.map((file) => (
                <span className="contextFileChip" key={file.id}>
                  <FileUp size={13} />
                  <span>
                    <strong>{file.path}</strong>
                    <small>{formatFileSize(file.size)}</small>
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {selectedRun ? (
        <RunDetail
          run={selectedRun}
          isMutating={isMutating}
          onAdvance={onAdvance}
          onDecideGate={onDecideGate}
        />
      ) : (
        <section className="panel emptyState">
          <Bot size={22} />
          <p>Start a run to generate artifacts and execution history.</p>
        </section>
      )}
    </div>
  )
}
```

- [ ] **Step 7: Add `ProjectPhaseTimeline`**

Add this component before `ProjectDetail`:

```tsx
function ProjectPhaseTimeline({ overview }: { overview: ProjectOverview }) {
  const currentIndex = Math.max(
    0,
    overview.phaseLabels.indexOf(overview.project.currentPhase)
  )

  return (
    <section className="panel timelinePanel">
      <div className="stageTrack">
        {overview.phaseLabels.map((phase, index) => {
          const progress =
            index < currentIndex
              ? 100
              : index === currentIndex
                ? phase === "Completed"
                  ? 100
                  : 68
                : 0
          const stageClass =
            index < currentIndex || phase === "Completed"
              ? "stage done"
              : index === currentIndex
                ? "stage current"
                : "stage"

          return (
            <div className={`${stageClass} projectPhase`} key={phase}>
              <span
                className="stageRing"
                style={
                  {
                    "--stage-progress": `${progress}%`
                  } as CSSProperties
                }
              >
                {progress}%
              </span>
              <small>{phase}</small>
            </div>
          )
        })}
      </div>
    </section>
  )
}
```

- [ ] **Step 8: Add CSS for the project action stack**

Append this to `app/globals.css`:

```css
.projectActionStack {
  align-items: flex-end;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.gateActions.compact {
  flex-wrap: wrap;
  justify-content: flex-end;
}

.stage.projectPhase {
  min-width: 92px;
}
```

- [ ] **Step 9: Run verification**

Run:

```bash
npm run typecheck
npm run lint
npm run build
```

Expected: all commands PASS.

- [ ] **Step 10: Commit**

```bash
git add app/page.tsx components/harness-dashboard.tsx app/globals.css
git commit -m "Present projects as the primary command center surface

The dashboard now starts from projects, shows project phase and command
state first, and keeps workflow runs available as execution history under
the selected project.

Constraint: First screen must be the working product, not a landing page
Rejected: Preserve run-first navigation | conflicts with the project command center model
Confidence: medium
Scope-risk: moderate
Tested: npm run typecheck; npm run lint; npm run build
Not-tested: Manual browser layout checks"
```

---

### Task 8: Browser Verification and Final Polish

**Files:**
- Modify as needed: `components/harness-dashboard.tsx`
- Modify as needed: `app/globals.css`

- [ ] **Step 1: Start the dev server**

Run:

```bash
npm run dev
```

Expected: Next.js starts on `http://localhost:3000`. If port 3000 is occupied, Next prints the alternate localhost URL.

- [ ] **Step 2: Manually verify project creation**

Open the dev URL and perform this flow:

```text
1. Select project type "Decision".
2. Enter project name "Database Choice".
3. Enter goal "Choose the database for event history."
4. Leave repository blank.
5. Click "Create Project".
```

Expected:

```text
Projects list contains "Database Choice".
Project detail shows "Decision".
Phase timeline labels are Question, Options, Evidence, Tradeoff, Record, Completed.
Next action says "Frame the decision question."
No workflow run is started automatically.
```

- [ ] **Step 3: Manually verify run controls are project-scoped**

From the selected project:

```text
1. Click "Start Run".
2. Confirm the run detail appears under the project.
3. Click "Advance" until a pending approval gate appears.
4. Click "Approve".
```

Expected:

```text
The generated workflow run has projectName "Database Choice".
The run remains under the selected project.
The command queue shows pending gates when gates are open.
Approving the gate refreshes the project without switching to another project.
```

- [ ] **Step 4: Verify legacy state migration**

Temporarily copy `data/harness-state.json` outside the repo, then replace it with:

```json
{
  "workflowRuns": [
    {
      "schemaVersion": 2,
      "version": 1,
      "id": "legacy-run-demo",
      "projectName": "Legacy Demo",
      "repository": "owner/repo",
      "requirement": "Preserve old workflow state",
      "contextFiles": [],
      "source": "dashboard",
      "currentStage": "plan",
      "status": "pending",
      "selectedAgent": "codex",
      "stageModes": {
        "intake": "hybrid",
        "plan": "hybrid",
        "design": "hybrid",
        "implementation": "hybrid",
        "verification": "hybrid",
        "completed": "manual"
      },
      "skillAssignments": {},
      "approvalPolicies": [],
      "eventSkills": [],
      "events": [],
      "artifacts": [],
      "approvalGates": [],
      "agentRuns": [],
      "revisions": [],
      "eventLogStatus": "consistent",
      "createdAt": "2026-07-28T00:00:00.000Z",
      "updatedAt": "2026-07-28T00:01:00.000Z"
    }
  ]
}
```

Refresh the browser.

Expected:

```text
Projects list contains "Legacy Demo".
The project type is Development.
The run appears under the project.
No page crash occurs.
```

After verification, restore the original `data/harness-state.json` copy.

- [ ] **Step 5: Run final standard verification**

Run:

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

Expected: all commands PASS.

- [ ] **Step 6: Commit polish fixes**

Only commit if Step 2 through Step 5 required additional edits:

```bash
git add components/harness-dashboard.tsx app/globals.css
git commit -m "Polish command center project flows after browser verification

Manual browser checks tightened layout and project-scoped run behavior
after the project-first dashboard landed.

Constraint: Preserve the focused first-version scope
Confidence: medium
Scope-risk: narrow
Tested: npm test; npm run typecheck; npm run lint; npm run build; manual browser project creation; manual browser project run flow; legacy state migration refresh
Not-tested: Multi-user concurrent mutations"
```

If no edits are needed, record no commit for this task.

---

## Self-Review

**Spec coverage:**
Workspace and Project are implemented in Tasks 1-3. Six project types and templates are implemented in Task 1. Project creation is implemented in Tasks 5-7. Project list and active project view are implemented in Tasks 6-7. Project overview fields are implemented through `Project`, `ProjectOverview`, and `ProjectDetail` in Tasks 2 and 7. Project timeline uses template phases in Task 7 and run events remain visible through existing `RunDetail`. Artifacts, approval gates, agent runs, and context files are aggregated in Tasks 2 and 7. Run controls scoped to a project are implemented in Tasks 5 and 7. Existing run-only state migration is implemented in Tasks 2-3. Standard verification is included in Tasks 3, 5, 7, and 8.

**Placeholder scan:**
This plan contains no deferred implementation placeholders. Every code-changing step names exact files, exact insertion or replacement content, and exact commands with expected results.

**Type consistency:**
The plan consistently uses `ProjectType`, `ProjectTemplate`, `ProjectOverview`, `WorkspaceWarning`, `HarnessState.projects`, `WorkflowRun.projectId`, `createProject`, `normalizeWorkspace`, `getProjectOverview`, `refreshProjectAfterRun`, and `createWorkflowRun({ projectId, ... })` across tasks.

## Final Verification Checklist

- [ ] `npm test` passes.
- [ ] `npm run typecheck` passes.
- [ ] `npm run lint` passes.
- [ ] `npm run build` passes.
- [ ] Browser project creation works for all six project types.
- [ ] Starting a run from a project links the run to that project.
- [ ] Approve, request changes, reject, advance, stop stage, and cancel run still work from the selected project.
- [ ] Legacy run-only state normalizes into a development project.
- [ ] Project artifact drift warnings preserve readable state instead of crashing.
