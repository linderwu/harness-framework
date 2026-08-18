import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"

import { createOpenClawA2AEnvelope } from "../lib/a2a-protocol"
import { ConversationHistorySync } from "../lib/conversation-history-sync"
import type { ConversationEntry } from "../lib/hive-memory/types"
import type { Artifact, WorkflowEventSkill, WorkflowRun } from "../lib/types"

const conversationHistory = [
  { role: "user" as const, content: "[operator] status update" },
  { role: "assistant" as const, content: "[gengar] ack" }
]

const workflowRun: WorkflowRun = {
  schemaVersion: 1,
  version: 7,
  id: "run-123",
  projectId: "project-123",
  projectName: "Project Hydra",
  repository: "github.com/acme/hydra",
  requirement: "Ship the thing",
  contextFiles: [],
  source: "dashboard",
  currentStage: "implementation",
  status: "running",
  selectedAgent: "openclaw.gengar",
  stageModes: {
    intake: "manual",
    plan: "manual",
    design: "manual",
    implementation: "agent",
    verification: "manual",
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
  createdAt: "2026-08-18T00:00:00.000Z",
  updatedAt: "2026-08-18T00:00:00.000Z"
}

const workflowSkill: WorkflowEventSkill = {
  id: "conversation.unbound_limited",
  eventType: "requirement_intake",
  stage: "implementation",
  name: "OpenClaw conversation",
  purpose: "Reply to the operator",
  trigger: "The operator sent a message.",
  allowedActors: ["openclaw.gengar"],
  inputs: ["conversation history"],
  outputs: ["reply"],
  constraints: ["Stay read-only."],
  gates: ["No workflow mutation."],
  knowledgeSources: ["persisted conversation"],
  verificationRules: ["Return one concise text response."]
}

function createEnvelopeInput() {
  return {
    run: workflowRun,
    skill: workflowSkill,
    executor: "openclaw.gengar",
    stage: "implementation",
    artifactType: "log" as Artifact["type"],
    title: "Unbound limited conversation",
    fallbackBody: "fallback body",
    idempotencyKey: "idem-123",
    sessionKey: "session-123",
    mainAgent: "gengar",
    conversationId: "conversation-123",
    conversationHistory
  } as const
}

function makeEntry(input: {
  id: string
  role: ConversationEntry["role"]
  content: string
  agentId?: ConversationEntry["agentId"]
}) {
  return input
}

test("legacy OpenClaw A2A envelope includes conversationId and conversationHistory in the task payload", () => {
  const envelope = createOpenClawA2AEnvelope(
    createEnvelopeInput() as never,
    "legacy-clawcodex-v0.1"
  )

  assert.ok("body" in envelope)
  const payload = JSON.parse(envelope.body)

  assert.equal(payload.conversationId, "conversation-123")
  assert.deepEqual(payload.conversationHistory, conversationHistory)
})

test("public OpenClaw A2A envelope includes conversationId and conversationHistory in the task payload", () => {
  const envelope = createOpenClawA2AEnvelope(
    createEnvelopeInput() as never,
    "public-a2a-v0.3"
  )

  assert.ok("params" in envelope)
  const payload = envelope.params.message.parts[0]?.data

  assert.equal(payload?.conversationId, "conversation-123")
  assert.deepEqual(payload?.conversationHistory, conversationHistory)
})

test("ConversationHistorySync returns only the post-delivery delta for the same agent conversation", () => {
  const sync = new ConversationHistorySync()
  const initialEntries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" }),
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.gengar", content: "agent 2" })
  ]
  const initialResult = sync.getDelta({
    key: "unbound:openclaw.gengar:conversation-123",
    sessionIdentity: "openclaw.gengar:conversation-123",
    targetAgent: "openclaw.gengar",
    entries: initialEntries
  })

  sync.markDelivered({
    key: "unbound:openclaw.gengar:conversation-123",
    sessionIdentity: "openclaw.gengar:conversation-123",
    cursorEntryId: initialResult.cursorEntryId
  })

  const nextEntries = [
    ...initialEntries,
    makeEntry({ id: "entry-3", role: "user", content: "user 3" }),
    makeEntry({ id: "entry-4", role: "agent", agentId: "openclaw.gengar", content: "self reply 4" })
  ]

  const result = sync.getDelta({
    key: "unbound:openclaw.gengar:conversation-123",
    sessionIdentity: "openclaw.gengar:conversation-123",
    targetAgent: "openclaw.gengar",
    entries: nextEntries
  })

  assert.deepEqual(result.history, [
    { role: "user", content: "[user] user 3" }
  ])
  assert.equal(result.cursorEntryId, "entry-4")
})

test("hive-services source wires incremental unbound sync and removes target-only filtering", () => {
  const source = readFileSync(resolve("lib/hive-services.ts"), "utf8")

  assert.match(source, /new ConversationHistorySync\(\)/)
  assert.match(source, /\.getDelta\(/)
  assert.match(source, /conversationHistory:\s*delta\.history/)
  assert.match(source, /result\.status !== "failed"/)
  assert.match(source, /\.markDelivered\(/)
  assert.doesNotMatch(source, /buildUnboundConversationHistory/)
  assert.doesNotMatch(source, /entry\.agentId === targetAgent/)
})
