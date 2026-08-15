import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createConversationService, listAllowedAgents } from "../lib/conversation"
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
    enqueueManagerWake: (input) => repository.enqueueManagerWake(input)
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
  assert.deepEqual(listAllowedAgents(createRun("arceus_maintenance"), {}), ["codex"])
  assert.equal(listAllowedAgents(createRun("agent_task"), { "openclaw.gengar": "offline" }).includes("openclaw.gengar"), false)
})

test("context failures retain the committed user entry as failed", async (t) => {
  const run = createRun()
  const { repository, service } = await fixture(t, { run, failContext: true })
  await assert.rejects(() => service.postMessage({
    workflowRunId: run.id, targetAgent: "codex", content: "Inspect state", idempotencyKey: "message-fail"
  }), /context unavailable/)
  assert.equal(repository.listConversation(run.id)[0]?.status, "failed")
})
