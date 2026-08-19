import assert from "node:assert/strict"
import Database from "better-sqlite3"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { sha256Json } from "../lib/a2a-runtime"
import { legacyConversationId } from "../lib/conversation-identity"
import type { HiveDatabase } from "../lib/hive-memory/database"
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

  assert.equal(migratedDatabase.schemaVersion(), 5)
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

test("schema v4 migrates a v3 database and creates durable A2A tables", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-a2a-migration-"))
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
  `)
  seed.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(1, "2026-08-18T00:00:00.000Z")
  seed.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(2, "2026-08-18T00:01:00.000Z")
  seed.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)").run(3, "2026-08-18T00:02:00.000Z")
  seed.close()

  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  assert.equal(database.schemaVersion(), 5)
  const tables = database.read((connection) =>
    connection.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('a2a_tasks', 'a2a_messages', 'a2a_events')
      ORDER BY name ASC
    `).all() as Array<{ name: string }>
  )
  assert.deepEqual(tables.map((row) => row.name), ["a2a_events", "a2a_messages", "a2a_tasks"])
})

test("A2A repository persists redacted frames, idempotent tasks, ordered events, and restart-safe state", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-a2a-repository-"))
  const firstDatabase = openHiveDatabase({ dataDir })
  const reopened = {
    database: undefined as ReturnType<typeof openHiveDatabase> | undefined
  }
  let firstDatabaseClosed = false
  const closeFirstDatabase = () => {
    if (firstDatabaseClosed) {
      return
    }
    firstDatabase.close()
    firstDatabaseClosed = true
  }
  const closeReopenedDatabase = () => {
    reopened.database?.close()
    reopened.database = undefined
  }
  t.after(async () => {
    closeReopenedDatabase()
    closeFirstDatabase()
    await rm(dataDir, { recursive: true, force: true })
  })
  const firstRepository = createHiveMemoryRepository(firstDatabase)

  const created = await firstRepository.createA2ATask({
    workflowRunId: "run-a2a-1",
    contextId: "context-a2a-1",
    fromAgent: "codex",
    toAgent: "openclaw.rowlet",
    status: "submitted",
    requestMessageId: "request-message-1",
    idempotencyKey: "a2a-idempotency-1"
  })
  assert.equal(created.inserted, true)

  const duplicate = await firstRepository.createA2ATask({
    workflowRunId: "run-a2a-1",
    contextId: "context-a2a-1",
    fromAgent: "codex",
    toAgent: "openclaw.rowlet",
    status: "submitted",
    requestMessageId: "request-message-1",
    idempotencyKey: "a2a-idempotency-1"
  })
  assert.equal(duplicate.inserted, false)
  assert.equal(duplicate.task.id, created.task.id)
  assert.equal(
    firstRepository.getA2ATaskByIdempotencyKey("a2a-idempotency-1")?.id,
    created.task.id
  )

  const requestFrame = {
    method: "message/send",
    metadata: {
      authorization: "Bearer secret",
      nested: {
        token: "hidden",
        content: "keep"
      }
    }
  }
  const responseFrame = {
    result: {
      status: "completed",
      cookie: "nope",
      artifact: "response body"
    }
  }

  const message = await firstRepository.insertA2AMessage({
    taskId: created.task.id,
    contextId: "context-a2a-1",
    direction: "outbound",
    fromAgent: "codex",
    toAgent: "openclaw.rowlet",
    protocolVersion: "0.3.0",
    method: "message/send",
    transport: "openclaw-command",
    idempotencyKey: "message-idempotency-1",
    requestFrame,
    responseFrame,
    sentAt: "2026-08-19T00:00:01.000Z",
    receivedAt: "2026-08-19T00:00:02.000Z"
  })

  assert.match(message.requestJson, /REDACTED/)
  assert.doesNotMatch(message.requestJson, /Bearer secret/)
  assert.equal(
    message.requestSha256,
    sha256Json({
      method: "message/send",
      metadata: {
        authorization: "[REDACTED]",
        nested: {
          content: "keep",
          token: "[REDACTED]"
        }
      }
    })
  )
  assert.match(message.responseJson ?? "", /REDACTED/)
  assert.equal(message.responseSha256, sha256Json({
    result: {
      artifact: "response body",
      cookie: "[REDACTED]",
      status: "completed"
    }
  }))

  const queued = await firstRepository.appendA2AEvent({
    taskId: created.task.id,
    messageId: message.id,
    eventType: "message_queued",
    actor: "codex",
    payload: { requestMessageId: "request-message-1" }
  })
  const working = await firstRepository.appendA2AEvent({
    taskId: created.task.id,
    messageId: message.id,
    eventType: "task_working",
    actor: "openclaw.rowlet",
    payload: { progress: "started" }
  })
  const completed = await firstRepository.appendA2AEvent({
    taskId: created.task.id,
    messageId: message.id,
    eventType: "task_completed",
    actor: "openclaw.rowlet",
    payload: { artifactCount: 1 }
  })

  assert.deepEqual(
    [queued.sequence, working.sequence, completed.sequence],
    [1, 2, 3]
  )
  assert.deepEqual(queued.payload, { requestMessageId: "request-message-1" })

  const updatedTask = await firstRepository.updateA2ATask({
    id: created.task.id,
    remoteTaskId: "remote-task-1",
    status: "completed",
    completedAt: "2026-08-19T00:00:03.000Z"
  })
  assert.equal(updatedTask.status, "completed")
  assert.equal(updatedTask.remoteTaskId, "remote-task-1")

  closeFirstDatabase()

  reopened.database = openHiveDatabase({ dataDir })
  const secondRepository = createHiveMemoryRepository(reopened.database)

  const persistedTask = secondRepository.getA2ATask(created.task.id)
  assert.ok(persistedTask)
  assert.equal(persistedTask.status, "completed")
  assert.equal(persistedTask.remoteTaskId, "remote-task-1")

  const persistedMessages = secondRepository.listA2AMessages(created.task.id)
  assert.equal(persistedMessages.length, 1)
  assert.match(persistedMessages[0]?.requestJson ?? "", /REDACTED/)
  assert.doesNotMatch(persistedMessages[0]?.requestJson ?? "", /Bearer secret/)

  const persistedEvents = secondRepository.listA2AEvents(created.task.id)
  assert.deepEqual(
    persistedEvents.map((event) => ({
      sequence: event.sequence,
      eventType: event.eventType,
      payload: event.payload
    })),
    [
      {
        sequence: 1,
        eventType: "message_queued",
        payload: { requestMessageId: "request-message-1" }
      },
      {
        sequence: 2,
        eventType: "task_working",
        payload: { progress: "started" }
      },
      {
        sequence: 3,
        eventType: "task_completed",
        payload: { artifactCount: 1 }
      }
    ]
  )

  closeReopenedDatabase()
})

test("A2A events redact secret-bearing payload keys before persistence and listing", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-a2a-event-redaction-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  const repository = createHiveMemoryRepository(database)

  const { task } = await repository.createA2ATask({
    contextId: "context-redaction-1",
    fromAgent: "codex",
    toAgent: "openclaw.rowlet",
    status: "submitted",
    requestMessageId: "request-redaction-1",
    idempotencyKey: "task-redaction-1"
  })

  const event = await repository.appendA2AEvent({
    taskId: task.id,
    eventType: "task_working",
    actor: "codex",
    payload: {
      authorization: "Bearer secret",
      nested: {
        token: "hidden",
        password: "super-secret",
        cookieJar: "crumbs",
        keep: "visible"
      }
    }
  })

  assert.deepEqual(event.payload, {
    authorization: "[REDACTED]",
    nested: {
      token: "[REDACTED]",
      password: "[REDACTED]",
      cookieJar: "[REDACTED]",
      keep: "visible"
    }
  })

  const listed = repository.listA2AEvents(task.id)
  assert.deepEqual(listed[0]?.payload, {
    authorization: "[REDACTED]",
    nested: {
      token: "[REDACTED]",
      password: "[REDACTED]",
      cookieJar: "[REDACTED]",
      keep: "visible"
    }
  })
})

test("updateA2ATask returns its own projection even when another update is queued before readback", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-a2a-task-atomicity-"))
  const baseDatabase = openHiveDatabase({ dataDir })
  t.after(async () => {
    baseDatabase.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  let injected = false
  let taskIdForInjectedUpdate = ""
  const wrappedDatabase: HiveDatabase = {
    ...baseDatabase,
    read<T>(operation: Parameters<HiveDatabase["read"]>[0]) {
      return baseDatabase.read((connection) => {
        if (!injected && taskIdForInjectedUpdate) {
          injected = true
          connection.prepare(`
            UPDATE a2a_tasks
            SET status = 'failed', remote_task_id = 'remote-task-race', updated_at = ?
            WHERE id = ?
          `).run("2026-08-19T00:00:02.000Z", taskIdForInjectedUpdate)
        }
        return operation(connection) as T
      })
    }
  }

  const repository = createHiveMemoryRepository(wrappedDatabase)
  const { task } = await repository.createA2ATask({
    contextId: "context-atomicity-1",
    fromAgent: "codex",
    toAgent: "openclaw.rowlet",
    status: "submitted",
    requestMessageId: "request-atomicity-1",
    idempotencyKey: "task-atomicity-1"
  })
  taskIdForInjectedUpdate = task.id

  const updated = await repository.updateA2ATask({
    id: task.id,
    status: "completed",
    remoteTaskId: "remote-task-original",
    completedAt: "2026-08-19T00:00:01.000Z"
  })

  assert.equal(updated.status, "completed")
  assert.equal(updated.remoteTaskId, "remote-task-original")
  assert.equal(updated.completedAt, "2026-08-19T00:00:01.000Z")

  const persisted = repository.getA2ATask(task.id)
  assert.equal(persisted?.status, "failed")
  assert.equal(persisted?.remoteTaskId, "remote-task-race")
})
