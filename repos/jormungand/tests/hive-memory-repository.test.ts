import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { legacyConversationId } from "../lib/conversation-identity"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

type ConversationState = "active" | "archived"

interface ConversationMetadata {
  conversationId: string
  title: string
  state: ConversationState
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

interface ConversationSummary {
  conversationId: string
  title: string
  state: ConversationState
  messageCount: number
  latestMessageAt?: string
  latestMessage?: string
}

type ConversationRepository = ReturnType<typeof createHiveMemoryRepository> & {
  getConversationMetadata(id: string): ConversationMetadata | undefined
  listConversationSummaries(input?: { includeArchived?: boolean }): ConversationSummary[]
}

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

test("schema v3 backfills conversation metadata from legacy entries and keeps unbound listing compatible", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-backfill-"))
  const databasePath = join(dataDir, "hive-memory.sqlite")

  const seed = new Database(databasePath)
  seed.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
    CREATE TABLE conversation_entries (
      id TEXT PRIMARY KEY,
      workflow_run_id TEXT NOT NULL,
      task_id TEXT,
      role TEXT NOT NULL,
      agent_id TEXT,
      content TEXT NOT NULL,
      importance TEXT NOT NULL,
      status TEXT NOT NULL,
      reply_to_id TEXT,
      artifact_ids_json TEXT NOT NULL,
      memory_ids_json TEXT NOT NULL,
      idempotency_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    );
    CREATE INDEX conversation_run_created_idx ON conversation_entries(workflow_run_id, created_at, id);
    CREATE TABLE codex_sessions (
      conversation_id TEXT PRIMARY KEY,
      bridge_session_id TEXT NOT NULL UNIQUE,
      codex_thread_id TEXT NOT NULL,
      status TEXT NOT NULL,
      turn_status TEXT NOT NULL,
      current_turn_id TEXT,
      cursor INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `)
  seed.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "2026-08-17T00:00:00.000Z")
  seed.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, "2026-08-17T00:01:00.000Z")
  seed.prepare(`
    INSERT INTO conversation_entries(
      id, workflow_run_id, task_id, role, agent_id, content, importance,
      status, reply_to_id, artifact_ids_json, memory_ids_json,
      idempotency_key, created_at
    ) VALUES (?, ?, NULL, ?, NULL, ?, 'normal', ?, NULL, '[]', '[]', ?, ?)
  `).run(
    "entry-1",
    "conversation:44444444-4444-4444-8444-444444444444",
    "user",
    "   This migrated title should be truncated to eighty characters exactly after whitespace cleanup and trimming.   ",
    "completed",
    "migrate-1",
    "2026-08-17T01:00:00.000Z"
  )
  seed.prepare(`
    INSERT INTO conversation_entries(
      id, workflow_run_id, task_id, role, agent_id, content, importance,
      status, reply_to_id, artifact_ids_json, memory_ids_json,
      idempotency_key, created_at
    ) VALUES (?, ?, NULL, ?, NULL, ?, 'important', ?, ?, '[]', '[]', ?, ?)
  `).run(
    "entry-2",
    "conversation:44444444-4444-4444-8444-444444444444",
    "agent",
    "Most recent assistant reply.",
    "completed",
    "entry-1",
    "migrate-2",
    "2026-08-17T01:05:00.000Z"
  )
  seed.prepare(`
    INSERT INTO conversation_entries(
      id, workflow_run_id, task_id, role, agent_id, content, importance,
      status, reply_to_id, artifact_ids_json, memory_ids_json,
      idempotency_key, created_at
    ) VALUES (?, ?, NULL, ?, NULL, ?, 'normal', ?, NULL, '[]', '[]', ?, ?)
  `).run(
    "entry-legacy",
    legacyConversationId,
    "manager",
    "Legacy-only manager note.",
    "completed",
    "migrate-legacy",
    "2026-08-17T02:00:00.000Z"
  )
  seed.close()

  const migratedDatabase = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(migratedDatabase) as ConversationRepository
  t.after(async () => {
    migratedDatabase.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  assert.equal(migratedDatabase.schemaVersion(), 3)
  const migrated = repository.getConversationMetadata("conversation:44444444-4444-4444-8444-444444444444")
  assert.ok(migrated)
  assert.equal(migrated.title, "This migrated title should be truncated to eighty characters exactly after white")
  assert.equal(migrated.state, "active")

  const legacy = repository.getConversationMetadata(legacyConversationId)
  assert.ok(legacy)
  assert.equal(legacy.title, "New conversation")

  const summaries = repository.listConversationSummaries({ includeArchived: true })
  assert.deepEqual(
    summaries.map((summary: ConversationSummary) => ({
      conversationId: summary.conversationId,
      title: summary.title,
      messageCount: summary.messageCount,
      latestMessage: summary.latestMessage
    })),
    [
      {
        conversationId: legacyConversationId,
        title: "New conversation",
        messageCount: 1,
        latestMessage: "Legacy-only manager note."
      },
      {
        conversationId: "conversation:44444444-4444-4444-8444-444444444444",
        title: "This migrated title should be truncated to eighty characters exactly after white",
        messageCount: 2,
        latestMessage: "Most recent assistant reply."
      }
    ]
  )

  assert.deepEqual(
    repository.listUnboundConversations().map((summary) => ({
      conversationId: summary.conversationId,
      messageCount: summary.messageCount,
      latestMessage: summary.latestMessage
    })),
    [
      {
        conversationId: legacyConversationId,
        messageCount: 1,
        latestMessage: "Legacy-only manager note."
      },
      {
        conversationId: "conversation:44444444-4444-4444-8444-444444444444",
        messageCount: 2,
        latestMessage: "Most recent assistant reply."
      }
    ]
  )
})
