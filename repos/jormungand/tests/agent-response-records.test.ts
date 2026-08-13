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
  assert.equal(
    formatAgentTaskRecordMarkdown(run({ projectType: "development" })),
    undefined
  )
})

test("runs without an Agent Response artifact are not formatted", () => {
  assert.equal(formatAgentTaskRecordMarkdown(run({ artifacts: [] })), undefined)
})
