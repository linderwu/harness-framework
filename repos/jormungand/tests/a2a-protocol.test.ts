import assert from "node:assert/strict"
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"

import { createOpenClawA2AEnvelope } from "../lib/a2a-protocol"
import { buildSharedConversationHistory } from "../lib/conversation-history"
import { ConversationHistorySync } from "../lib/conversation-history-sync"
import type { ConversationEntry } from "../lib/hive-memory/types"
import type { AgentInvocationInput } from "../lib/agent-bridge"
import type { Artifact, WorkflowEventSkill, WorkflowRun } from "../lib/types"
type HiveServicesModule = typeof import("../lib/hive-services")

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

async function ensureCompiledAlias() {
  const tmpRoot = join(process.cwd(), ".tmp-tests")
  const scopedRoot = join(tmpRoot, "node_modules", "@")
  const libLink = join(scopedRoot, "lib")
  const expectedTarget = join(tmpRoot, "lib")

  await mkdir(scopedRoot, { recursive: true })
  const existingLink = await lstat(libLink).catch(() => undefined)
  const existingTarget = existingLink?.isSymbolicLink()
    ? await realpath(libLink).catch(() => undefined)
    : undefined
  const expectedRealTarget = await realpath(expectedTarget).catch(() => undefined)
  if (existingTarget && expectedRealTarget && existingTarget === expectedRealTarget) {
    return
  }
  if (existingLink) {
    await rm(libLink, { recursive: true, force: true })
  }
  await symlink(expectedTarget, libLink, "junction").catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  })
}

async function loadRouteOpenClawUnboundConversation() {
  await ensureCompiledAlias()
  const { routeOpenClawUnboundConversation } =
    await import("../lib/hive-services") as HiveServicesModule
  return routeOpenClawUnboundConversation
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

test("unbound OpenClaw routing seeds once, then sends only delta, and failed delivery does not advance cursor", async () => {
  const routeOpenClawUnboundConversation = await loadRouteOpenClawUnboundConversation()
  const sync = new ConversationHistorySync()
  const capturedInputs: AgentInvocationInput[] = []
  const statuses: Array<"completed" | "failed"> = [
    "completed",
    "completed",
    "failed",
    "completed"
  ]
  const initialEntries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" }),
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.rowlet", content: "rowlet 2" })
  ]

  const invokeAgent = async (input: AgentInvocationInput) => {
    capturedInputs.push(input)
    return {
      status: statuses.shift() ?? "completed",
      body: `${input.executor} reply`
    }
  }

  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation-123",
    targetAgent: "openclaw.gengar",
    content: "latest operator message",
    entries: initialEntries,
    invokeAgent
  })

  const secondEntries = [
    ...initialEntries,
    makeEntry({ id: "entry-3", role: "user", content: "user 3" }),
    makeEntry({ id: "entry-4", role: "agent", agentId: "openclaw.gengar", content: "self 4" })
  ]
  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation-123",
    targetAgent: "openclaw.gengar",
    content: "latest operator message",
    entries: secondEntries,
    invokeAgent
  })

  const thirdEntries = [
    ...secondEntries,
    makeEntry({ id: "entry-5", role: "user", content: "user 5" })
  ]
  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation-123",
    targetAgent: "openclaw.gengar",
    content: "latest operator message",
    entries: thirdEntries,
    invokeAgent
  })
  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation-123",
    targetAgent: "openclaw.gengar",
    content: "latest operator message",
    entries: thirdEntries,
    invokeAgent
  })

  assert.deepEqual(capturedInputs[0]?.conversationHistory, buildSharedConversationHistory(initialEntries))
  assert.deepEqual(
    capturedInputs[1]?.conversationHistory,
    buildSharedConversationHistory([secondEntries[2]!])
  )
  assert.deepEqual(
    capturedInputs[2]?.conversationHistory,
    buildSharedConversationHistory([thirdEntries[4]!])
  )
  assert.deepEqual(
    capturedInputs[3]?.conversationHistory,
    buildSharedConversationHistory([thirdEntries[4]!])
  )
})

test("unbound OpenClaw routing keeps an independent seed and cursor per agent in the same conversation", async () => {
  const routeOpenClawUnboundConversation = await loadRouteOpenClawUnboundConversation()
  const sync = new ConversationHistorySync()
  const capturedInputs: AgentInvocationInput[] = []
  const baseEntries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" }),
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.gengar", content: "gengar 2" })
  ]
  const invokeAgent = async (input: AgentInvocationInput) => {
    capturedInputs.push(input)
    return { status: "completed" as const, body: `${input.executor} reply` }
  }

  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation-123",
    targetAgent: "openclaw.gengar",
    content: "latest operator message",
    entries: baseEntries,
    invokeAgent
  })
  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation-123",
    targetAgent: "openclaw.rowlet",
    content: "latest operator message",
    entries: baseEntries,
    invokeAgent
  })

  const nextEntries = [
    ...baseEntries,
    makeEntry({ id: "entry-3", role: "user", content: "user 3" }),
    makeEntry({ id: "entry-4", role: "agent", agentId: "openclaw.rowlet", content: "rowlet 4" })
  ]
  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation-123",
    targetAgent: "openclaw.rowlet",
    content: "latest operator message",
    entries: nextEntries,
    invokeAgent
  })

  assert.deepEqual(capturedInputs[0]?.conversationHistory, buildSharedConversationHistory(baseEntries))
  assert.deepEqual(capturedInputs[1]?.conversationHistory, buildSharedConversationHistory(baseEntries))
  assert.deepEqual(
    capturedInputs[2]?.conversationHistory,
    buildSharedConversationHistory([nextEntries[2]!])
  )
})
