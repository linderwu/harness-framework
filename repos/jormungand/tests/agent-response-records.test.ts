import assert from "node:assert/strict"
import test from "node:test"
import {
  createAgentTaskRecords,
  getAgentTaskResponseArtifact,
  publishAgentTaskResponseRecord
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

test("agent task record paths split instruction and raw response documents by run", () => {
  assert.deepEqual(
    createAgentTaskRecords(run())?.map((record) => record.path),
    [
      "records/2026/08/13/run-123/original-instruction.md",
      "records/2026/08/13/run-123/raw-agent-response.md"
    ]
  )
})

test("agent task response artifact is located by title and type", () => {
  const artifact = getAgentTaskResponseArtifact(run())

  assert.equal(artifact?.id, "artifact-123")
  assert.equal(artifact?.title, "Agent Response")
})

test("agent task record markdown splits original instruction and raw response", () => {
  const records = createAgentTaskRecords(run())

  assert.ok(records)
  assert.equal(records.length, 2)
  assert.match(records[0].content, /^# Original Instruction/)
  assert.match(records[0].content, /Project: Summarize Notes/)
  assert.match(records[0].content, /Workflow Run: run-123/)
  assert.match(records[0].content, /## Original Instruction\n\nSummarize today's notes\./)
  assert.doesNotMatch(records[0].content, /Raw Agent Response/)
  assert.match(records[1].content, /^# Raw Agent Response/)
  assert.match(records[1].content, /Project: Summarize Notes/)
  assert.match(records[1].content, /Workflow Run: run-123/)
  assert.match(records[1].content, /## Raw Agent Response\n\nAction 1: follow up with the team\./)
  assert.match(records[1].content, /## Closeout Status\n\ncomplete/)
  assert.doesNotMatch(records[1].content, /\*\*Original Instruction\*\*/)
})

test("non-agent-task runs are not formatted as agent task records", () => {
  assert.equal(
    createAgentTaskRecords(run({ projectType: "development" })),
    undefined
  )
})

test("runs without an Agent Response artifact are not formatted", () => {
  assert.equal(createAgentTaskRecords(run({ artifacts: [] })), undefined)
})

test("publishing an agent task record writes instruction and raw response documents", async () => {
  const calls: Array<{
    repository: string
    path: string
    content: string
    message: string
  }> = []

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
  assert.equal(calls.length, 2)
  assert.equal(calls[0].repository, "jormungand-record")
  assert.equal(
    calls[0].path,
    "records/2026/08/13/run-123/original-instruction.md"
  )
  assert.equal(
    calls[1].path,
    "records/2026/08/13/run-123/raw-agent-response.md"
  )
  assert.match(
    calls[0].message,
    /Record Agent Task original instruction for Summarize Notes/
  )
  assert.match(
    calls[1].message,
    /Record Agent Task raw response for Summarize Notes/
  )
  assert.match(calls[0].content, /# Original Instruction/)
  assert.match(calls[1].content, /# Raw Agent Response/)
})
