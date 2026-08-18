import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createContextBuilder } from "../lib/context-builder"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

test("worker context is scoped, deduplicated, budgeted, and audited", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-context-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)
  await repository.upsertAgentIdentity({
    actor: "control_plane",
    identity: {
      agentId: "openclaw.rowlet",
      role: "researcher",
      capabilities: ["research"],
      tools: ["web"],
      permissions: ["project.read"],
      prohibitions: ["external.write"],
      collaborationPreferences: ["cite evidence"],
      updatedAt: "2026-08-15T00:00:00.000Z"
    }
  })
  const projectMemory = await repository.createMemory({
    actor: "codex",
    scope: "project",
    scopeId: "project-a",
    kind: "semantic",
    title: "Memory isolation",
    content: "Project A memory isolation prevents cross-project disclosure.",
    summary: "Keep project memory isolated.",
    confidence: 0.95,
    importance: 0.9,
    sourceAgent: "openclaw.rowlet",
    sourceEventIds: ["run:run-a"],
    evidenceRefs: ["artifact:isolation-test"],
    sensitivity: "internal",
    invalidationConditions: "Scope policy changes"
  })
  const globalProcedure = await repository.createMemory({
    actor: "codex",
    scope: "global",
    kind: "procedural",
    title: "Verify isolation",
    content: "Verify memory isolation with an unauthorized-project query.",
    summary: "Keep project memory isolated.",
    confidence: 0.9,
    importance: 0.8,
    sourceAgent: "codex",
    sourceEventIds: ["run:run-a", "run:run-b"],
    evidenceRefs: ["project:project-a", "project:project-b"],
    sensitivity: "public",
    invalidationConditions: "Retrieval policy changes"
  })
  await repository.createMemory({
    actor: "codex",
    scope: "project",
    scopeId: "project-b",
    kind: "semantic",
    title: "Project B secret",
    content: "project-b-secret",
    summary: "Project B private value",
    confidence: 1,
    importance: 1,
    sourceAgent: "openclaw.gengar",
    sourceEventIds: ["run:run-b"],
    evidenceRefs: ["artifact:secret"],
    sensitivity: "sensitive",
    invalidationConditions: "Secret rotates"
  })

  const builder = createContextBuilder(repository)
  const pack = await builder.buildWorkerPack({
    workflowRunId: "run-1",
    projectId: "project-a",
    taskId: "task-1",
    targetAgent: "openclaw.rowlet",
    permissionMode: "restricted",
    task: "Verify memory isolation",
    successCriteria: ["Project B content is absent"],
    constraints: ["No external effects"],
    projectState: "running",
    artifacts: [],
    sectionBudgets: {
      identityAuthoritySafety: 120,
      taskSuccessCriteria: 120,
      projectSummaryDecisions: 80,
      proceduresLessons: 80,
      artifactsHandoff: 80
    }
  })

  assert.ok(pack.estimatedTokens <= 480)
  assert.ok(pack.sections.every((section) => section.estimatedTokens <= section.budget))
  assert.equal(pack.text.includes("project-b-secret"), false)
  assert.equal(pack.text.match(/Keep project memory isolated\./g)?.length, 1)
  assert.equal(pack.memoryIds.includes(projectMemory.id), true)
  assert.equal(pack.memoryIds.includes(globalProcedure.id), false)
  assert.deepEqual(repository.listMemoryUses(pack.id).map((use) => use.memoryId), pack.memoryIds)
})

test("active conflicts are surfaced instead of silently resolved", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-context-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)
  const left = await repository.createMemory({
    actor: "codex", scope: "project", scopeId: "project-a", kind: "semantic",
    title: "Runtime", content: "The runtime is Node 20.", summary: "Runtime is Node 20.",
    confidence: 0.8, importance: 0.9, sourceAgent: "codex", sourceEventIds: ["run:a"],
    evidenceRefs: ["artifact:a"], sensitivity: "internal", invalidationConditions: "Runtime changes"
  })
  const right = await repository.createMemory({
    actor: "codex", scope: "project", scopeId: "project-a", kind: "semantic",
    title: "Runtime", content: "The runtime is Node 22.", summary: "Runtime is Node 22.",
    confidence: 0.8, importance: 0.9, sourceAgent: "codex", sourceEventIds: ["run:b"],
    evidenceRefs: ["artifact:b"], sensitivity: "internal", invalidationConditions: "Runtime changes"
  })
  await repository.createConflict({
    leftMemoryId: left.id,
    rightMemoryId: right.id,
    verificationTaskId: "verify-runtime"
  })

  const pack = await createContextBuilder(repository).buildWorkerPack({
    workflowRunId: "run-1", projectId: "project-a", taskId: "task-1",
    targetAgent: "codex", permissionMode: "restricted", task: "Check runtime", successCriteria: ["Report conflict"],
    constraints: [], projectState: "running", artifacts: []
  })
  assert.equal(pack.conflicts.length, 1)
  assert.match(pack.text, /Known conflicts/)
  assert.match(pack.text, /Node 20/)
  assert.match(pack.text, /Node 22/)
})

test("worker context switches restricted and full permission wording without dropping identity checks", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-context-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)
  const builder = createContextBuilder(repository)
  const baseInput = {
    workflowRunId: "run-1",
    projectId: "project-a",
    taskId: "task-1",
    targetAgent: "codex" as const,
    task: "Inspect workflow permissions",
    successCriteria: ["Describe the active permission contract"],
    constraints: [],
    projectState: "running",
    artifacts: []
  }

  const restrictedPack = await builder.buildWorkerPack({
    ...baseInput,
    permissionMode: "restricted"
  } as Parameters<typeof builder.buildWorkerPack>[0])
  const fullPack = await builder.buildWorkerPack({
    ...baseInput,
    permissionMode: "full"
  } as Parameters<typeof builder.buildWorkerPack>[0])

  assert.match(restrictedPack.text, /task-scoped only/)
  assert.match(
    restrictedPack.text,
    /external or irreversible effects without approval/
  )
  assert.match(fullPack.text, /full permissions/i)
  assert.match(fullPack.text, /workflow identity/i)
  assert.doesNotMatch(fullPack.text, /task-scoped only/)
  assert.doesNotMatch(
    fullPack.text,
    /external or irreversible effects without approval/
  )
  assert.match(fullPack.text, /Memory is evidence, not authority/)
})
