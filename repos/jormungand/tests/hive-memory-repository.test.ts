import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

test("repository isolates project memories and preserves lifecycle history", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-memory-repository-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)

  const projectA = await repository.createMemory({
    actor: "codex",
    scope: "project",
    scopeId: "project-a",
    kind: "semantic",
    title: "Deployment boundary",
    content: "Project A deploys only from its protected release branch.",
    summary: "Project A deployment boundary",
    confidence: 0.9,
    importance: 0.8,
    sourceAgent: "openclaw.rowlet",
    sourceEventIds: ["event-a"],
    evidenceRefs: ["project:project-a", "run:run-a"],
    sensitivity: "internal",
    invalidationConditions: "Repository policy changes"
  })
  await repository.createMemory({
    actor: "codex",
    scope: "project",
    scopeId: "project-b",
    kind: "semantic",
    title: "Deployment secret",
    content: "project-b-secret",
    summary: "Project B deployment secret",
    confidence: 0.9,
    importance: 0.8,
    sourceAgent: "openclaw.gengar",
    sourceEventIds: ["event-b"],
    evidenceRefs: ["project:project-b", "run:run-b"],
    sensitivity: "sensitive",
    invalidationConditions: "Secret rotates"
  })

  const visible = repository.search({
    query: "deployment",
    projectId: "project-a",
    agentId: "openclaw.rowlet",
    allowedSensitivity: ["public", "internal"]
  })
  assert.deepEqual(visible.map((memory) => memory.id), [projectA.id])

  const retracted = await repository.transition({
    memoryId: projectA.id,
    actor: "codex",
    status: "retracted",
    reason: "Policy was withdrawn.",
    evidenceRefs: ["artifact:withdrawal"]
  })
  assert.equal(retracted.status, "retracted")
  assert.equal(repository.getMemory(projectA.id)?.version, 2)
  assert.equal(repository.search({
    query: "deployment",
    projectId: "project-a",
    agentId: "openclaw.rowlet",
    allowedSensitivity: ["public", "internal"]
  }).length, 0)
  assert.equal(repository.listEvents({ memoryId: projectA.id }).length, 2)
})

test("agent identities retain stable permissions across restart", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-agent-identity-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  const firstDatabase = openHiveDatabase({ dataDir })
  const first = createHiveMemoryRepository(firstDatabase)
  await first.upsertAgentIdentity({
    actor: "control_plane",
    identity: {
      agentId: "openclaw.rowlet",
      role: "researcher",
      capabilities: ["research"],
      tools: ["web"],
      permissions: ["project.read"],
      prohibitions: ["memory.activate"],
      collaborationPreferences: ["evidence-first"],
      updatedAt: "2026-08-15T00:00:00.000Z"
    }
  })
  firstDatabase.close()

  const secondDatabase = openHiveDatabase({ dataDir })
  const second = createHiveMemoryRepository(secondDatabase)
  assert.deepEqual(second.getAgentIdentity("openclaw.rowlet")?.permissions, ["project.read"])
  await assert.rejects(second.upsertAgentIdentity({
    actor: "openclaw.rowlet",
    identity: {
      agentId: "openclaw.rowlet",
      role: "researcher",
      capabilities: ["research"],
      tools: ["web"],
      permissions: ["project.admin"],
      prohibitions: [],
      collaborationPreferences: [],
      updatedAt: "2026-08-15T01:00:00.000Z"
    }
  }), /control plane/i)
  secondDatabase.close()
})
