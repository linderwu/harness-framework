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
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import type { WorkflowRun } from "../lib/types"
import { createWorkflowRun } from "../lib/workflow"

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
      return { status: "completed", body: "Isolation verified.\n\nraw evidence" }
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
  assert.deepEqual(repository.listConversation(run.id).map((entry) => entry.role), ["user", "manager"])
  assert.equal(repository.listConversation(run.id).every((entry) => entry.workflowRunId === run.id), true)
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
