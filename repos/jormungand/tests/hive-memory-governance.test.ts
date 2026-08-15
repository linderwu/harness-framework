import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createMemoryGovernance } from "../lib/hive-memory/governance"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

test("workers submit candidates but cannot mutate formal memory", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-governance-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)
  const governance = createMemoryGovernance(repository)
  const candidate = await repository.submitCandidate({
    observation: "The repository requires a clean typecheck before build.",
    proposedScope: "project",
    proposedScopeId: "project-a",
    proposedKind: "procedural",
    confidence: 0.8,
    importance: 0.7,
    sourceAgent: "openclaw.rowlet",
    sensitivity: "internal",
    evidenceRefs: ["artifact:typecheck"],
    sourceEventIds: ["run:run-a"],
    invalidationConditions: "Build pipeline changes"
  })

  await assert.rejects(
    governance.apply({ actor: "openclaw.rowlet", action: "activate", candidateId: candidate.id }),
    /workers cannot mutate formal memory/i
  )
  const outcome = await governance.promoteCandidate({ actor: "codex", candidateId: candidate.id })
  assert.equal(outcome.status, "activated")
})

test("global promotion requires corroboration and merges exact duplicates", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-governance-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)
  const governance = createMemoryGovernance(repository)
  const weakCandidate = await repository.submitCandidate({
    observation: "Run typecheck before build.",
    proposedScope: "global",
    proposedKind: "procedural",
    confidence: 0.8,
    importance: 0.8,
    sourceAgent: "openclaw.rowlet",
    sensitivity: "public",
    evidenceRefs: ["project:project-a"],
    sourceEventIds: ["run:run-a"],
    invalidationConditions: "Toolchain changes"
  })
  const rejected = await governance.promoteCandidate({ actor: "codex", candidateId: weakCandidate.id })
  assert.equal(rejected.status, "rejected")

  const first = await repository.submitCandidate({
    observation: "Run typecheck before build.",
    proposedScope: "global",
    proposedKind: "procedural",
    confidence: 0.9,
    importance: 0.8,
    sourceAgent: "openclaw.rowlet",
    sensitivity: "public",
    evidenceRefs: ["project:project-a", "project:project-b"],
    sourceEventIds: ["run:run-a", "run:run-b"],
    invalidationConditions: "Toolchain changes"
  })
  const activated = await governance.promoteCandidate({ actor: "codex", candidateId: first.id })
  assert.equal(activated.status, "activated")

  const duplicate = await repository.submitCandidate({
    observation: "  Run typecheck before build.  ",
    proposedScope: "global",
    proposedKind: "procedural",
    confidence: 0.95,
    importance: 0.9,
    sourceAgent: "openclaw.gengar",
    sensitivity: "public",
    evidenceRefs: ["project:project-c", "artifact:ci-log"],
    sourceEventIds: ["run:run-c"],
    invalidationConditions: "Toolchain changes"
  })
  const merged = await governance.promoteCandidate({ actor: "codex", candidateId: duplicate.id })
  assert.equal(merged.status, "merged")
  if (merged.status === "merged") {
    assert.equal(merged.memory.evidenceRefs.includes("artifact:ci-log"), true)
  }
})

test("secret values cannot be promoted as memory content", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-governance-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)
  const governance = createMemoryGovernance(repository)
  const candidate = await repository.submitCandidate({
    observation: "token=plain-text-secret",
    proposedScope: "project",
    proposedScopeId: "project-a",
    proposedKind: "semantic",
    confidence: 1,
    importance: 1,
    sourceAgent: "openclaw.gengar",
    sensitivity: "sensitive",
    evidenceRefs: ["artifact:secret-scan"],
    sourceEventIds: ["run:run-a"],
    invalidationConditions: "Credential rotates"
  })
  const outcome = await governance.promoteCandidate({ actor: "codex", candidateId: candidate.id })
  assert.equal(outcome.status, "rejected")
  if (outcome.status === "rejected") assert.match(outcome.reason, /secret reference/i)
})
