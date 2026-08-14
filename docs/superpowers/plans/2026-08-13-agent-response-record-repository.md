# Agent Response Record Repository Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically publish every completed Agent Task response to the GitHub repository `jormungand-record` while preserving the existing local dashboard state.

**Architecture:** Keep `data/harness-state.json` as the operational source of truth. Add a focused record module that formats completed Agent Task runs as deterministic Markdown and publishes them through a small GitHub contents API helper. Inject the publisher into `advanceWorkflow` so tests can use a fake publisher and the API route can use the real GitHub publisher.

**Tech Stack:** Next.js route handlers, TypeScript, Node `node:test`, GitHub REST Contents API, existing `GITHUB_TOKEN` / `GH_TOKEN` / `gh` authentication patterns.

---

## File Structure

- Create `repos/jormungand/lib/agent-response-records.ts`
  Owns record path generation, Markdown formatting, Agent Response artifact lookup, repository target resolution, and production publish orchestration.

- Modify `repos/jormungand/lib/github-repository.ts`
  Export a reusable `upsertGitHubFile` helper for creating or updating one file in an existing or newly ensured repository.

- Modify `repos/jormungand/lib/workflow.ts`
  Add an optional `publishAgentTaskRecord` callback to `advanceWorkflow` options. After an Agent Task response succeeds, call the callback and append a concise publish status to the existing `agent_task.response` workflow event note.

- Modify `repos/jormungand/app/api/workflow-runs/route.ts`
  Pass the production publisher into `advanceWorkflow` for dashboard-created workflow runs.

- Modify `repos/jormungand/app/api/projects/[id]/workflow-runs/route.ts`
  Pass the same production publisher into the project-specific Agent Task start path.

- Create `repos/jormungand/tests/agent-response-records.test.ts`
  Tests deterministic record paths, Markdown formatting, and skip behavior for non-Agent Task runs or missing response artifacts.

- Modify `repos/jormungand/tests/workspace-model.test.ts`
  Tests workflow integration with a fake publisher and verifies publish failure does not fail the completed Agent Task.

- Modify `repos/jormungand/package.json`
  Add the new test file and new library module to the existing `npm run test` TypeScript compile command.

---

### Task 1: Define Record Formatting And Path Tests

**Files:**
- Create: `repos/jormungand/tests/agent-response-records.test.ts`
- Create: `repos/jormungand/lib/agent-response-records.ts`

- [ ] **Step 1: Write the failing tests**

Create `repos/jormungand/tests/agent-response-records.test.ts` with:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  formatAgentTaskRecordMarkdown,
  getAgentTaskRecordPath,
  getAgentTaskResponseArtifact
} from "../lib/agent-response-records"
import type { WorkflowRun } from "../lib/types"

function run(overrides: Partial<WorkflowRun> = {}): WorkflowRun {
  return {
    schemaVersion: 2,
    version: 1,
    id: overrides.id ?? "run-123",
    projectId: overrides.projectId ?? "project-123",
    projectName: overrides.projectName ?? "Summarize Notes",
    projectType: overrides.projectType ?? "agent_task",
    repository: overrides.repository ?? "linderwu/source-repo",
    requirement: overrides.requirement ?? "Summarize today's notes.",
    contextFiles: overrides.contextFiles ?? [],
    source: overrides.source ?? "dashboard",
    sourceRef: overrides.sourceRef,
    currentStage: overrides.currentStage ?? "completed",
    status: overrides.status ?? "completed",
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
    artifacts:
      overrides.artifacts ??
      [
        {
          id: "artifact-123",
          workflowRunId: "run-123",
          stage: "intake",
          type: "log",
          title: "Agent Response",
          body: [
            "**Original Instruction**",
            "Summarize today's notes.",
            "",
            "**Raw Agent Response**",
            "Action 1: follow up with the team.",
            "",
            "**Agent Response**",
            "Action 1: follow up with the team.",
            "",
            "**Closeout Status**",
            "complete"
          ].join("\n"),
          createdAt: "2026-08-13T10:11:12.000Z"
        }
      ],
    approvalGates: overrides.approvalGates ?? [],
    agentRuns: overrides.agentRuns ?? [],
    revisions: overrides.revisions ?? [],
    eventLogStatus: overrides.eventLogStatus ?? "consistent",
    createdAt: overrides.createdAt ?? "2026-08-13T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-08-13T10:12:00.000Z"
  }
}

test("agent task record path is deterministic from run updated date and id", () => {
  assert.equal(
    getAgentTaskRecordPath(run()),
    "records/2026/08/13/run-123.md"
  )
})

test("agent task response artifact is located by title and type", () => {
  const artifact = getAgentTaskResponseArtifact(run())

  assert.equal(artifact?.id, "artifact-123")
  assert.equal(artifact?.title, "Agent Response")
})

test("agent task record markdown includes metadata, instruction, response, and closeout", () => {
  const markdown = formatAgentTaskRecordMarkdown(run())

  assert.match(markdown, /^# Agent Task Response/)
  assert.match(markdown, /Project: Summarize Notes/)
  assert.match(markdown, /Workflow Run: run-123/)
  assert.match(markdown, /Project ID: project-123/)
  assert.match(markdown, /Selected Agent: codex/)
  assert.match(markdown, /Source: dashboard/)
  assert.match(markdown, /Repository: linderwu\/source-repo/)
  assert.match(markdown, /Status: completed/)
  assert.match(markdown, /Created: 2026-08-13T10:00:00.000Z/)
  assert.match(markdown, /Updated: 2026-08-13T10:12:00.000Z/)
  assert.match(markdown, /## Original Instruction\n\nSummarize today's notes\./)
  assert.match(markdown, /## Raw Agent Response\n\nAction 1: follow up with the team\./)
  assert.match(markdown, /## Closeout Status\n\ncomplete/)
})

test("non-agent-task runs are not formatted as agent task records", () => {
  assert.equal(formatAgentTaskRecordMarkdown(run({ projectType: "development" })), undefined)
})

test("runs without an Agent Response artifact are not formatted", () => {
  assert.equal(formatAgentTaskRecordMarkdown(run({ artifacts: [] })), undefined)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `repos/jormungand`:

```powershell
npm run test
```

Expected: TypeScript compile fails because `../lib/agent-response-records` does not exist.

- [ ] **Step 3: Create the minimal formatter module**

Create `repos/jormungand/lib/agent-response-records.ts`:

```ts
import type { Artifact, WorkflowRun } from "./types"

export interface AgentTaskRecord {
  path: string
  content: string
}

export function getAgentTaskResponseArtifact(run: WorkflowRun) {
  if (run.projectType !== "agent_task") {
    return undefined
  }

  return run.artifacts.find(
    (artifact) => artifact.type === "log" && artifact.title === "Agent Response"
  )
}

export function getAgentTaskRecordPath(run: WorkflowRun) {
  const date = new Date(run.updatedAt || run.createdAt)
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")

  return `records/${year}/${month}/${day}/${run.id}.md`
}

export function formatAgentTaskRecordMarkdown(run: WorkflowRun) {
  const artifact = getAgentTaskResponseArtifact(run)

  if (!artifact) {
    return undefined
  }

  const sections = parseMixedResponseArtifact(artifact)

  return [
    "# Agent Task Response",
    "",
    `Project: ${run.projectName}`,
    `Workflow Run: ${run.id}`,
    `Project ID: ${run.projectId}`,
    `Selected Agent: ${run.selectedAgent}`,
    `Source: ${run.source}`,
    run.repository ? `Repository: ${run.repository}` : undefined,
    `Status: ${run.status}`,
    `Created: ${run.createdAt}`,
    `Updated: ${run.updatedAt}`,
    "",
    "## Original Instruction",
    "",
    sections.originalInstruction || run.requirement,
    "",
    "## Raw Agent Response",
    "",
    sections.rawAgentResponse || artifact.body,
    "",
    "## Closeout Status",
    "",
    sections.closeoutStatus || inferCloseoutStatus(run)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

export function createAgentTaskRecord(run: WorkflowRun): AgentTaskRecord | undefined {
  const content = formatAgentTaskRecordMarkdown(run)

  if (!content) {
    return undefined
  }

  return {
    path: getAgentTaskRecordPath(run),
    content
  }
}

function parseMixedResponseArtifact(artifact: Artifact) {
  return {
    originalInstruction: readMarkdownSection(artifact.body, "Original Instruction"),
    rawAgentResponse: readMarkdownSection(artifact.body, "Raw Agent Response"),
    closeoutStatus: readMarkdownSection(artifact.body, "Closeout Status")
  }
}

function readMarkdownSection(body: string, title: string) {
  const marker = `**${title}**`
  const start = body.indexOf(marker)

  if (start < 0) {
    return ""
  }

  const contentStart = start + marker.length
  const nextSection = body.indexOf("\n**", contentStart)
  const raw =
    nextSection >= 0
      ? body.slice(contentStart, nextSection)
      : body.slice(contentStart)

  return raw.trim()
}

function inferCloseoutStatus(run: WorkflowRun) {
  return run.status === "failed" ? "failed" : "complete"
}
```

- [ ] **Step 4: Add the new test file to the package test command**

Modify `repos/jormungand/package.json` so the `test` script includes:

```text
tests/agent-response-records.test.ts
```

and:

```text
lib/agent-response-records.ts
```

The script should continue compiling to `.tmp-tests` and running `node --test .tmp-tests/tests/*.test.js`.

- [ ] **Step 5: Run test to verify it passes**

Run from `repos/jormungand`:

```powershell
npm run test
```

Expected: PASS for the new record formatter tests and existing tests.

- [ ] **Step 6: Commit**

Run from the repository root:

```powershell
git add repos/jormungand/lib/agent-response-records.ts repos/jormungand/tests/agent-response-records.test.ts repos/jormungand/package.json
git commit -m "Prepare deterministic records for completed agent tasks" -m "Agent Task responses need a stable Markdown representation before they can be mirrored to GitHub. This isolates path and body formatting from workflow execution and remote publishing." -m "Constraint: Existing tests compile an explicit TypeScript file list" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: npm run test"
```

---

### Task 2: Add GitHub File Upsert Support

**Files:**
- Modify: `repos/jormungand/lib/github-repository.ts`
- Test: `repos/jormungand/tests/agent-response-records.test.ts`

- [ ] **Step 1: Add a unit test for publish orchestration with a fake upsert**

Append this test to `repos/jormungand/tests/agent-response-records.test.ts`:

```ts
import { publishAgentTaskResponseRecord } from "../lib/agent-response-records"

test("publishing an agent task record uses the configured repository and deterministic path", async () => {
  const calls: Array<{ repository: string; path: string; content: string; message: string }> = []

  const result = await publishAgentTaskResponseRecord(run(), {
    upsertFile: async (input) => {
      calls.push(input)
      return {
        status: "published",
        repository: "linderwu/jormungand-record",
        path: input.path,
        htmlUrl: `https://github.com/linderwu/jormungand-record/blob/main/${input.path}`
      }
    }
  })

  assert.equal(result.status, "published")
  assert.equal(calls.length, 1)
  assert.equal(calls[0].repository, "jormungand-record")
  assert.equal(calls[0].path, "records/2026/08/13/run-123.md")
  assert.match(calls[0].message, /Record Agent Task response for Summarize Notes/)
  assert.match(calls[0].content, /# Agent Task Response/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `repos/jormungand`:

```powershell
npm run test
```

Expected: TypeScript compile fails because `publishAgentTaskResponseRecord` is not exported.

- [ ] **Step 3: Export GitHub file upsert types and helper**

Modify `repos/jormungand/lib/github-repository.ts` near the existing interfaces:

```ts
interface GitHubContentResponse {
  content?: {
    html_url?: string
  }
}

interface GitHubFileResponse {
  sha?: string
  content?: {
    html_url?: string
  }
}

export interface GitHubFileUpsertInput {
  repository: string
  path: string
  content: string
  message: string
}

export interface GitHubFileUpsertResult {
  status: "published" | "unchanged"
  repository: string
  path: string
  htmlUrl?: string
}
```

Add this exported function after `ensureGitHubRepository`:

```ts
export async function upsertGitHubFile(
  input: GitHubFileUpsertInput
): Promise<GitHubFileUpsertResult> {
  const fullName = await ensureGitHubRepository(input.repository)
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN

  if (token) {
    return upsertGitHubFileWithApi({ ...input, repository: fullName }, token)
  }

  return upsertGitHubFileWithCli({ ...input, repository: fullName })
}
```

- [ ] **Step 4: Add the API-backed upsert implementation**

Add these helpers in `repos/jormungand/lib/github-repository.ts` below `githubFetch`:

```ts
async function upsertGitHubFileWithApi(
  input: GitHubFileUpsertInput,
  token: string
): Promise<GitHubFileUpsertResult> {
  const current = await githubFetch(
    `https://api.github.com/repos/${input.repository}/contents/${encodeGitHubPath(input.path)}`,
    token
  )
  let sha: string | undefined
  let htmlUrl: string | undefined

  if (current.ok) {
    const data = (await current.json()) as GitHubFileResponse
    sha = data.sha
    htmlUrl = data.content?.html_url
  } else if (current.status !== 404) {
    throw new GitHubRepositoryError(
      `Could not check ${input.path} in ${input.repository}: HTTP ${current.status}.`,
      current.status
    )
  }

  if (sha && (await remoteFileMatches(input, token))) {
    return {
      status: "unchanged",
      repository: input.repository,
      path: input.path,
      htmlUrl
    }
  }

  const response = await githubFetch(
    `https://api.github.com/repos/${input.repository}/contents/${encodeGitHubPath(input.path)}`,
    token,
    {
      method: "PUT",
      body: JSON.stringify({
        message: input.message,
        content: Buffer.from(input.content, "utf8").toString("base64"),
        sha
      })
    }
  )

  if (!response.ok) {
    const details = await response.text().catch(() => "")
    throw new GitHubRepositoryError(
      `Could not write ${input.path} in ${input.repository}: HTTP ${response.status}${details ? ` ${details}` : ""}`,
      response.status
    )
  }

  const data = (await response.json()) as GitHubContentResponse

  return {
    status: "published",
    repository: input.repository,
    path: input.path,
    htmlUrl: data.content?.html_url
  }
}

async function remoteFileMatches(input: GitHubFileUpsertInput, token: string) {
  const response = await githubFetch(
    `https://raw.githubusercontent.com/${input.repository}/HEAD/${input.path}`,
    token,
    {
      headers: {
        Accept: "text/plain"
      }
    }
  )

  if (!response.ok) {
    return false
  }

  return (await response.text()) === input.content
}

function encodeGitHubPath(filePath: string) {
  return filePath.split("/").map(encodeURIComponent).join("/")
}
```

- [ ] **Step 5: Add the CLI-backed upsert implementation**

Add these helpers near `ensureRepositoryWithCli`:

```ts
async function upsertGitHubFileWithCli(
  input: GitHubFileUpsertInput
): Promise<GitHubFileUpsertResult> {
  const current = await runCommand("gh", [
    "api",
    `repos/${input.repository}/contents/${input.path}`,
    "--jq",
    ".sha"
  ])
  const sha = current.exitCode === 0 ? current.stdout.trim() : undefined

  if (sha && (await remoteFileMatchesWithCli(input))) {
    return {
      status: "unchanged",
      repository: input.repository,
      path: input.path,
      htmlUrl: `https://github.com/${input.repository}/blob/HEAD/${input.path}`
    }
  }

  const args = [
    "api",
    "-X",
    "PUT",
    `repos/${input.repository}/contents/${input.path}`,
    "-f",
    `message=${input.message}`,
    "-f",
    `content=${Buffer.from(input.content, "utf8").toString("base64")}`
  ]

  if (sha) {
    args.push("-f", `sha=${sha}`)
  }

  await runGh(args)

  return {
    status: "published",
    repository: input.repository,
    path: input.path,
    htmlUrl: `https://github.com/${input.repository}/blob/HEAD/${input.path}`
  }
}

async function remoteFileMatchesWithCli(input: GitHubFileUpsertInput) {
  const response = await runCommand("gh", [
    "api",
    `repos/${input.repository}/contents/${input.path}`,
    "--jq",
    ".content"
  ])

  if (response.exitCode !== 0) {
    return false
  }

  const normalized = response.stdout.replace(/\s/g, "")
  const current = Buffer.from(normalized, "base64").toString("utf8")

  return current === input.content
}
```

- [ ] **Step 6: Implement publish orchestration in the record module**

Modify `repos/jormungand/lib/agent-response-records.ts`:

```ts
import {
  upsertGitHubFile,
  type GitHubFileUpsertInput,
  type GitHubFileUpsertResult
} from "./github-repository"
```

Add these exports:

```ts
export interface AgentTaskRecordPublishOptions {
  repository?: string
  upsertFile?: (input: GitHubFileUpsertInput) => Promise<GitHubFileUpsertResult>
}

export type AgentTaskRecordPublishResult =
  | GitHubFileUpsertResult
  | {
      status: "skipped"
      reason: "not_agent_task" | "missing_response_artifact"
    }

export async function publishAgentTaskResponseRecord(
  run: WorkflowRun,
  options: AgentTaskRecordPublishOptions = {}
): Promise<AgentTaskRecordPublishResult> {
  if (run.projectType !== "agent_task") {
    return { status: "skipped", reason: "not_agent_task" }
  }

  const record = createAgentTaskRecord(run)

  if (!record) {
    return { status: "skipped", reason: "missing_response_artifact" }
  }

  const repository =
    options.repository ??
    process.env.JORMUNGAND_RECORD_REPOSITORY ??
    "jormungand-record"
  const upsertFile = options.upsertFile ?? upsertGitHubFile

  return upsertFile({
    repository,
    path: record.path,
    content: record.content,
    message: `Record Agent Task response for ${run.projectName}`
  })
}
```

- [ ] **Step 7: Run tests**

Run from `repos/jormungand`:

```powershell
npm run test
```

Expected: PASS.

- [ ] **Step 8: Commit**

Run from the repository root:

```powershell
git add repos/jormungand/lib/github-repository.ts repos/jormungand/lib/agent-response-records.ts repos/jormungand/tests/agent-response-records.test.ts
git commit -m "Publish agent response records through GitHub contents" -m "Completed Agent Task responses need a focused GitHub write path that can create or update deterministic Markdown files without changing dashboard storage semantics." -m "Constraint: GitHub auth may come from token env vars or gh CLI" -m "Rejected: Shelling out from workflow logic | keeps remote write mechanics isolated" -m "Confidence: medium" -m "Scope-risk: moderate" -m "Tested: npm run test"
```

---

### Task 3: Wire Record Publishing Into Agent Task Completion

**Files:**
- Modify: `repos/jormungand/lib/workflow.ts`
- Modify: `repos/jormungand/tests/workspace-model.test.ts`

- [ ] **Step 1: Write the workflow integration tests**

Append these tests to `repos/jormungand/tests/workspace-model.test.ts`:

```ts
test("agent task workflow publishes completed response records when a publisher is provided", async () => {
  const project = createProject({
    name: "Record Notes",
    type: "agent_task",
    goal: "Summarize notes for the archive.",
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
  const publishedRuns: WorkflowRun[] = []

  const completedRun = await advanceWorkflow(run, {
    invokeAgent: async () => ({
      status: "completed",
      source: "codex-bridge",
      body: "Archived response body."
    }),
    publishAgentTaskRecord: async (nextRun) => {
      publishedRuns.push(nextRun)
      return {
        status: "published",
        repository: "linderwu/jormungand-record",
        path: "records/2026/08/13/run.md",
        htmlUrl: "https://github.com/linderwu/jormungand-record/blob/main/records/2026/08/13/run.md"
      }
    }
  })

  assert.equal(completedRun.status, "completed")
  assert.equal(publishedRuns.length, 1)
  assert.match(completedRun.events[0].note ?? "", /Agent response record published/)
})

test("agent task workflow keeps completed response when record publishing fails", async () => {
  const project = createProject({
    name: "Record Failure",
    type: "agent_task",
    goal: "Keep the local response even when GitHub fails.",
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
      body: "Local response survives."
    }),
    publishAgentTaskRecord: async () => {
      throw new Error("GitHub unavailable")
    }
  })

  assert.equal(completedRun.status, "completed")
  assert.equal(completedRun.currentStage, "completed")
  assert.equal(completedRun.artifacts[0].title, "Agent Response")
  assert.match(completedRun.artifacts[0].body, /Local response survives\./)
  assert.match(completedRun.events[0].note ?? "", /Agent response record publish failed: GitHub unavailable/)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run from `repos/jormungand`:

```powershell
npm run test
```

Expected: TypeScript compile fails because `publishAgentTaskRecord` is not a valid `advanceWorkflow` option.

- [ ] **Step 3: Add publisher types to workflow**

Modify `repos/jormungand/lib/workflow.ts` near the `RuntimeSkillResolver` type:

```ts
export interface AgentTaskRecordPublishResult {
  status: "published" | "unchanged" | "skipped"
  repository?: string
  path?: string
  htmlUrl?: string
  reason?: string
}

export type AgentTaskRecordPublisher = (
  run: WorkflowRun
) => Promise<AgentTaskRecordPublishResult>
```

Modify the `advanceWorkflow` options type to include:

```ts
publishAgentTaskRecord?: AgentTaskRecordPublisher
```

Modify the `advanceAgentTask` options type to include the same property.

- [ ] **Step 4: Call the publisher after successful Agent Task completion**

In `advanceAgentTask`, after:

```ts
if (taskResult.status !== "failed") {
  run.currentStage = "completed"
  run.status = "completed"
}
```

add:

```ts
if (taskResult.status !== "failed" && options.publishAgentTaskRecord) {
  await publishCompletedAgentTaskRecord(run, options.publishAgentTaskRecord)
}
```

Add this helper below `advanceAgentTask`:

```ts
async function publishCompletedAgentTaskRecord(
  run: WorkflowRun,
  publishAgentTaskRecord: AgentTaskRecordPublisher
) {
  try {
    const result = await publishAgentTaskRecord(run)
    appendAgentTaskResponseEventNote(run, formatAgentTaskRecordPublishNote(result))
  } catch (error) {
    appendAgentTaskResponseEventNote(
      run,
      `Agent response record publish failed: ${formatError(error)}.`
    )
  }
}

function formatAgentTaskRecordPublishNote(result: AgentTaskRecordPublishResult) {
  if (result.status === "skipped") {
    return `Agent response record publish skipped: ${result.reason ?? "unknown reason"}.`
  }

  const target = [result.repository, result.path].filter(Boolean).join("/")
  const suffix = result.htmlUrl ? ` ${result.htmlUrl}` : ""

  return result.status === "unchanged"
    ? `Agent response record unchanged${target ? ` at ${target}` : ""}.${suffix}`
    : `Agent response record published${target ? ` at ${target}` : ""}.${suffix}`
}

function appendAgentTaskResponseEventNote(run: WorkflowRun, note: string) {
  const event = [...run.events]
    .reverse()
    .find((item) => item.skillId === "agent_task.response")

  if (!event) {
    return
  }

  event.note = [event.note, note].filter(Boolean).join(" ")
}
```

- [ ] **Step 5: Run tests**

Run from `repos/jormungand`:

```powershell
npm run test
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run from the repository root:

```powershell
git add repos/jormungand/lib/workflow.ts repos/jormungand/tests/workspace-model.test.ts
git commit -m "Mirror completed agent tasks without blocking local completion" -m "Workflow completion now accepts an injected record publisher so Agent Task responses can be mirrored after the local artifact is created. Publish failures are captured as event notes instead of discarding completed responses." -m "Constraint: Local workflow state remains the dashboard source of truth" -m "Rejected: Fail completed Agent Tasks on GitHub outage | violates best-effort archive behavior" -m "Confidence: high" -m "Scope-risk: moderate" -m "Tested: npm run test"
```

---

### Task 4: Connect The Production Publisher In API Routes

**Files:**
- Modify: `repos/jormungand/app/api/workflow-runs/route.ts`
- Modify: `repos/jormungand/app/api/projects/[id]/workflow-runs/route.ts`

- [ ] **Step 1: Wire the publisher in the global workflow run route**

Modify imports in `repos/jormungand/app/api/workflow-runs/route.ts`:

```ts
import { publishAgentTaskResponseRecord } from "@/lib/agent-response-records"
```

Modify the `advanceWorkflow` call:

```ts
const intakeRun = await advanceWorkflow(run, {
  invokeAgent: invokeConfiguredAgent,
  resolveRuntimeSkillBundles: createRuntimeSkillResolver(),
  publishAgentTaskRecord: publishAgentTaskResponseRecord
})
```

- [ ] **Step 2: Wire the publisher in the project-specific workflow run route**

Modify imports in `repos/jormungand/app/api/projects/[id]/workflow-runs/route.ts`:

```ts
import { publishAgentTaskResponseRecord } from "@/lib/agent-response-records"
```

Modify its `advanceWorkflow` call the same way:

```ts
const intakeRun = await advanceWorkflow(run, {
  invokeAgent: invokeConfiguredAgent,
  resolveRuntimeSkillBundles: createRuntimeSkillResolver(),
  publishAgentTaskRecord: publishAgentTaskResponseRecord
})
```

- [ ] **Step 3: Run typecheck**

Run from `repos/jormungand`:

```powershell
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run tests**

Run from `repos/jormungand`:

```powershell
npm run test
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run from the repository root:

```powershell
git add repos/jormungand/app/api/workflow-runs/route.ts repos/jormungand/app/api/projects/[id]/workflow-runs/route.ts
git commit -m "Enable automatic GitHub records for dashboard agent tasks" -m "Dashboard-created Agent Tasks now pass the production record publisher into workflow advancement, making completed responses automatically mirror to jormungand-record." -m "Constraint: Publishing stays server-side in API routes" -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: npm run typecheck; npm run test"
```

---

### Task 5: Final Verification

**Files:**
- Verify: `repos/jormungand/lib/agent-response-records.ts`
- Verify: `repos/jormungand/lib/github-repository.ts`
- Verify: `repos/jormungand/lib/workflow.ts`
- Verify: `repos/jormungand/app/api/workflow-runs/route.ts`
- Verify: `repos/jormungand/app/api/projects/[id]/workflow-runs/route.ts`
- Verify: `repos/jormungand/tests/agent-response-records.test.ts`
- Verify: `repos/jormungand/tests/workspace-model.test.ts`
- Verify: `repos/jormungand/package.json`

- [ ] **Step 1: Run lint**

Run from `repos/jormungand`:

```powershell
npm run lint
```

Expected: PASS with no ESLint errors.

- [ ] **Step 2: Run typecheck**

Run from `repos/jormungand`:

```powershell
npm run typecheck
```

Expected: PASS with no TypeScript errors.

- [ ] **Step 3: Run tests**

Run from `repos/jormungand`:

```powershell
npm run test
```

Expected: PASS with all `node:test` tests succeeding.

- [ ] **Step 4: Inspect the final diff**

Run from the repository root:

```powershell
git diff --stat HEAD~4..HEAD
git diff HEAD~4..HEAD -- repos/jormungand/lib/agent-response-records.ts repos/jormungand/lib/github-repository.ts repos/jormungand/lib/workflow.ts repos/jormungand/app/api/workflow-runs/route.ts repos/jormungand/app/api/projects/[id]/workflow-runs/route.ts repos/jormungand/tests/agent-response-records.test.ts repos/jormungand/tests/workspace-model.test.ts repos/jormungand/package.json
```

Expected: Diff is limited to record formatting, GitHub file upsert, workflow publisher injection, API route wiring, and tests.

- [ ] **Step 5: Optional manual smoke test with GitHub credentials**

Run only when `GITHUB_TOKEN`, `GH_TOKEN`, or authenticated `gh` is available:

```powershell
npm run dev
```

Create an Agent Task from the dashboard and wait for completion.

Expected:

- Local response appears in the dashboard.
- `data/harness-state.json` includes the Agent Response artifact.
- `jormungand-record` exists in GitHub.
- GitHub contains `records/YYYY/MM/DD/<workflowRunId>.md`.
- The workflow event note includes `Agent response record published`.

- [ ] **Step 6: Final commit if verification-only adjustments were needed**

If Task 5 required code or docs edits, commit them:

```powershell
git add repos/jormungand
git commit -m "Stabilize agent response record publishing" -m "Final verification adjustments keep the GitHub record archive path passing lint, typecheck, and tests." -m "Confidence: high" -m "Scope-risk: narrow" -m "Tested: npm run lint; npm run typecheck; npm run test"
```

If Task 5 required no edits, do not create an empty commit.

---

## Self-Review

- Spec coverage: The plan covers local state preservation, automatic publish after `agent_task.response`, `jormungand-record` defaulting, deterministic Markdown path/content, GitHub create/update behavior, best-effort failures, and focused tests.
- Placeholder scan: No `TBD`, `TODO`, `FIXME`, or vague "handle later" steps are present.
- Type consistency: Publisher/result names are consistent across `agent-response-records.ts`, `workflow.ts`, API routes, and tests.
