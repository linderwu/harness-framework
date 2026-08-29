import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createConversationService,
  listAllowedAgents,
  parseUnboundManagerDecision,
  unboundConversationId
} from "../lib/conversation"
import type { AgentInvocationInput } from "../lib/agent-bridge"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import type { WorkflowRun } from "../lib/types"
import { createWorkflowRun } from "../lib/workflow"
import { routeUnboundConversation } from "../lib/hive-services"

function createRun(projectType: WorkflowRun["projectType"] = "hive_mission") {
  return createWorkflowRun({
    projectId: "project-1", projectName: "Mission", projectType,
    repository: "owner/repo", requirement: "Verify isolation", selectedAgent: "codex",
    designApprovalActor: "human", verificationApprovalActor: "human"
  })
}

async function fixture(t: test.TestContext, options: {
  run?: WorkflowRun
  health?: Record<string, "online" | "busy" | "offline" | "disabled">
  failContext?: boolean
  invokeBody?: string
} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const run = options.run ?? createRun()
  let invocations = 0
  const service = createConversationService({
    repository,
    getRun: async (id) => id === run.id ? run : undefined,
    getHealth: () => options.health ?? {},
    buildContext: async () => {
      if (options.failContext) throw new Error("context unavailable")
      return undefined
    },
    invokeAgent: async () => {
      invocations += 1
      assert.equal(repository.listConversation(run.id)[0]?.status, "running")
      return { status: "completed", body: options.invokeBody ?? "Isolation verified.\n\nraw evidence" }
    },
    persistRawArtifact: async () => "artifact-1",
    enqueueManagerWake: (input) => repository.enqueueManagerWake(input),
    routeUnbound: async ({ targetAgent }) => ({
      status: "completed",
      body: "This belongs to Mission.",
      binding: targetAgent === "codex"
        ? { projectId: run.projectId, workflowRunId: run.id, projectName: run.projectName }
        : undefined
    })
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { repository, run, service, invocations: () => invocations }
}

test("conversation persists before dispatch and retries produce one response", async (t) => {
  const { repository, run, service, invocations } = await fixture(t)
  const first = await service.postMessage({
    workflowRunId: run.id, targetAgent: "codex", content: "Recheck isolation.", idempotencyKey: "message-1"
  })
  const retry = await service.postMessage({
    workflowRunId: run.id, targetAgent: "codex", content: "Recheck isolation.", idempotencyKey: "message-1"
  })

  assert.equal(first.userEntry.status, "completed")
  assert.equal(first.responseEntry?.artifactIds[0], "artifact-1")
  assert.equal(retry.duplicate, true)
  assert.equal(invocations(), 1)
  assert.equal(repository.listConversation(run.id).length, 2)
})

test("conversation service preserves exact assistant response whitespace in persisted entries", async (t) => {
  const { run, service } = await fixture(t, { invokeBody: " hello \n" })

  const result = await service.postMessage({
    workflowRunId: run.id,
    targetAgent: "codex",
    content: "Keep exact assistant output.",
    idempotencyKey: "message-exact-response"
  })

  assert.equal(result.responseEntry?.content, " hello \n")

  const whitespaceOnly = await fixture(t, { invokeBody: " \n" })
  const whitespaceOnlyResult = await whitespaceOnly.service.postMessage({
    workflowRunId: whitespaceOnly.run.id,
    targetAgent: "codex",
    content: "Keep whitespace-only assistant output.",
    idempotencyKey: "message-whitespace-only-response"
  })

  assert.equal(whitespaceOnlyResult.responseEntry?.content, " \n")
})

test("busy Hive worker remains queued and is visible to the manager", async (t) => {
  const { repository, run, service, invocations } = await fixture(t, { health: { "openclaw.gengar": "busy" } })
  const result = await service.postMessage({
    workflowRunId: run.id,
    targetAgent: "openclaw.gengar",
    content: "Recheck cross-project isolation.",
    idempotencyKey: "message-worker"
  })

  assert.equal(result.userEntry.status, "queued")
  assert.equal(invocations(), 0)
  assert.equal(repository.listEvents({ workflowRunId: run.id })
    .some((event) => event.eventType === "worker_message_visible_to_manager"), true)
  assert.equal(repository.listManagerWakes(run.id).length, 1)
})

test("routing excludes unavailable agents and fixes Arceus to Codex", () => {
  assert.deepEqual(listAllowedAgents("arceus_maintenance", {}), ["codex"])
  assert.equal(listAllowedAgents("agent_task", { "openclaw.gengar": "offline" }).includes("openclaw.gengar"), false)
})

test("context failures retain the committed user entry as failed", async (t) => {
  const run = createRun()
  const { repository, service } = await fixture(t, { run, failContext: true })
  await assert.rejects(() => service.postMessage({
    workflowRunId: run.id, targetAgent: "codex", content: "Inspect state", idempotencyKey: "message-fail"
  }), /context unavailable/)
  assert.equal(repository.listConversation(run.id)[0]?.status, "failed")
})

test("unbound conversation is persisted and moved intact after manager binding", async (t) => {
  const { repository, run, service } = await fixture(t)
  assert.deepEqual((await service.getUnboundConversation()).entries, [])

  const result = await service.postUnboundMessage({
    content: "Continue the Mission project.",
    idempotencyKey: "unbound-message"
  })

  assert.equal(result.binding?.workflowRunId, run.id)
  assert.equal(repository.listConversation(unboundConversationId).length, 0)
  const movedEntries = repository.listConversation(run.id)
  assert.equal(movedEntries.filter((entry) => entry.role === "user").length, 1)
  assert.equal(movedEntries.filter((entry) => entry.role === "manager").length, 1)
  const movedUser = movedEntries.find((entry) => entry.role === "user")
  const movedManager = movedEntries.find((entry) => entry.role === "manager")
  assert.ok(movedUser)
  assert.ok(movedManager)
  assert.equal(movedUser.workflowRunId, run.id)
  assert.equal(movedManager.workflowRunId, run.id)
  assert.equal(movedManager.replyToId, movedUser.id)
})

test("unbound conversation exposes the OpenClaw roster and preserves its target", async (t) => {
  const { repository, service } = await fixture(t)
  const initial = await service.getUnboundConversation()

  assert.deepEqual(initial.allowedAgents, [
    "codex",
    "openclaw.rowlet",
    "openclaw.roaringmoon",
    "openclaw.charizard",
    "openclaw.mrmime",
    "openclaw.gengar"
  ])

  const result = await service.postUnboundMessage({
    content: "Give me a short research note.",
    targetAgent: "openclaw.gengar",
    idempotencyKey: "unbound-openclaw-message"
  })

  assert.equal(result.binding, undefined)
  assert.equal(result.responseEntry?.agentId, "openclaw.gengar")
  assert.equal(result.responseEntry?.role, "agent")
  assert.equal(repository.listConversation(unboundConversationId).length, 2)
})

test("unbound conversation metadata and Codex dispatch preserve the selected model", async (t) => {
  const { repository, service } = await fixture(t)
  const conversationId = "conversation:model-persistence"
  await repository.createConversation({ id: conversationId, title: "Model persistence" })
  await repository.updateConversationModel({
    id: conversationId,
    selectedModelId: "gpt-5.6-sol"
  })

  const metadata = (await service.getUnboundConversation(conversationId) as {
    metadata?: { selectedModelId?: string }
  }).metadata
  assert.equal(metadata?.selectedModelId, "gpt-5.6-sol")

  const userEntry = (await repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content: "Use the saved model.",
    importance: "normal",
    status: "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "model-persistence-message"
  })).entry

  let observedRun: WorkflowRun | undefined
  const dispatchService = createConversationService({
    repository,
    getRun: async () => undefined,
    buildContext: async () => undefined,
    invokeAgent: async () => ({ status: "completed" as const, body: "unused" }),
    persistRawArtifact: async () => "unused-artifact",
    enqueueManagerWake: async () => undefined,
    routeUnbound: async (input) => routeUnboundConversation({
      ...input,
      repository,
      invokeAgent: async (agentInput: AgentInvocationInput) => {
        observedRun = agentInput.run
        return { status: "completed" as const, body: "Saved model used." }
      }
    })
  })

  await dispatchService.dispatchQueuedEntry({
    conversationId,
    targetAgent: "codex",
    userEntry
  })
  assert.equal(observedRun?.selectedModelId, "gpt-5.6-sol")

  observedRun = undefined
  const luckyInput = {
    repository,
    conversationId: "conversation:lucky-model-isolation",
    targetAgent: "mavis",
    selectedModelId: "gpt-5.6-sol",
    content: "Keep Lucky on its configured model.",
    entries: [],
    invokeAgent: async (agentInput: AgentInvocationInput) => {
      observedRun = agentInput.run
      return { status: "completed" as const, body: "Lucky response." }
    }
  } as Parameters<typeof routeUnboundConversation>[0] & { selectedModelId: string }
  await routeUnboundConversation(luckyInput)
  assert.equal((observedRun as WorkflowRun | undefined)?.selectedModelId, undefined)
})

test("manager binding parser keeps ambiguous messages unbound and rejects invented targets", () => {
  const run = createRun()
  assert.deepEqual(
    parseUnboundManagerDecision(JSON.stringify({ reply: "Which project do you mean?", projectId: null, workflowRunId: null }), [run]),
    { body: "Which project do you mean?" }
  )
  assert.throws(() => parseUnboundManagerDecision(JSON.stringify({
    reply: "Bound.", projectId: run.projectId, workflowRunId: "invented"
  }), [run]), /invalid project or workflow run/)
})
