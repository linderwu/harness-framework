import type Database from "better-sqlite3"
import { legacyConversationId } from "../conversation-identity"

export const hiveSchemaVersion = 10

const migrationV1 = `
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
CREATE TABLE hive_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  workflow_run_id TEXT,
  task_id TEXT,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE memories (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  summary TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  importance REAL NOT NULL,
  source_agent TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  expires_at TEXT,
  supersedes_id TEXT,
  sensitivity TEXT NOT NULL,
  version INTEGER NOT NULL,
  invalidation_conditions TEXT NOT NULL
);
CREATE TABLE memory_sources (
  memory_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  PRIMARY KEY(memory_id, event_id)
);
CREATE TABLE memory_evidence (
  memory_id TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  PRIMARY KEY(memory_id, evidence_ref)
);
CREATE TABLE memory_candidates (
  id TEXT PRIMARY KEY,
  observation TEXT NOT NULL,
  proposed_scope TEXT NOT NULL,
  proposed_scope_id TEXT,
  proposed_kind TEXT NOT NULL,
  confidence REAL NOT NULL,
  importance REAL NOT NULL,
  source_agent TEXT NOT NULL,
  sensitivity TEXT NOT NULL,
  evidence_refs_json TEXT NOT NULL,
  source_event_ids_json TEXT NOT NULL,
  invalidation_conditions TEXT NOT NULL,
  status TEXT NOT NULL,
  decision_reason TEXT,
  created_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE TABLE memory_uses (
  id TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  workflow_run_id TEXT NOT NULL,
  task_id TEXT,
  context_pack_id TEXT NOT NULL,
  outcome TEXT,
  used_at TEXT NOT NULL
);
CREATE TABLE memory_conflicts (
  id TEXT PRIMARY KEY,
  left_memory_id TEXT NOT NULL,
  right_memory_id TEXT NOT NULL,
  status TEXT NOT NULL,
  verification_task_id TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE TABLE agent_identities (
  agent_id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  tools_json TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  prohibitions_json TEXT NOT NULL,
  collaboration_preferences_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE manager_decisions (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  observation TEXT NOT NULL,
  decision TEXT NOT NULL,
  reason TEXT NOT NULL,
  proposal_json TEXT NOT NULL,
  accepted_actions_json TEXT NOT NULL,
  rejected_actions_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE manager_checkpoints (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  cycle INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL,
  next_wake_condition TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(workflow_run_id, cycle)
);
CREATE TABLE manager_tasks (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  parent_task_id TEXT,
  title TEXT NOT NULL,
  instruction TEXT NOT NULL,
  success_criteria_json TEXT NOT NULL,
  assigned_agent TEXT,
  status TEXT NOT NULL,
  strategy TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE manager_wakes (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT
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
CREATE VIRTUAL TABLE memories_fts USING fts5(
  memory_id UNINDEXED,
  title,
  summary,
  content
);
CREATE INDEX memories_scope_status_idx ON memories(scope, scope_id, status);
CREATE INDEX manager_tasks_run_status_idx ON manager_tasks(workflow_run_id, status);
CREATE INDEX manager_wakes_run_status_idx ON manager_wakes(workflow_run_id, status);
CREATE INDEX conversation_run_created_idx ON conversation_entries(workflow_run_id, created_at, id);
`

const migrationV2 = `
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
`

const migrationV3 = `
CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE INDEX conversations_state_updated_idx ON conversations(state, updated_at);
`

const migrationV4 = `
CREATE TABLE a2a_tasks (
  id TEXT PRIMARY KEY,
  workflow_run_id TEXT,
  context_id TEXT NOT NULL,
  remote_task_id TEXT,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  status TEXT NOT NULL,
  request_message_id TEXT NOT NULL UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE a2a_messages (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  context_id TEXT NOT NULL,
  parent_message_id TEXT,
  direction TEXT NOT NULL,
  from_agent TEXT NOT NULL,
  to_agent TEXT NOT NULL,
  protocol_version TEXT NOT NULL,
  method TEXT NOT NULL,
  transport TEXT NOT NULL,
  idempotency_key TEXT,
  request_json TEXT NOT NULL,
  response_json TEXT,
  request_sha256 TEXT NOT NULL,
  response_sha256 TEXT,
  created_at TEXT NOT NULL,
  sent_at TEXT,
  received_at TEXT
);
CREATE TABLE a2a_events (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  message_id TEXT,
  sequence INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(task_id, sequence)
);
CREATE INDEX a2a_tasks_status_updated_idx ON a2a_tasks(status, updated_at);
CREATE INDEX a2a_messages_context_created_idx ON a2a_messages(context_id, created_at);
CREATE INDEX a2a_messages_task_created_idx ON a2a_messages(task_id, created_at);
CREATE INDEX a2a_events_task_sequence_idx ON a2a_events(task_id, sequence);
`

const migrationV5 = `
ALTER TABLE conversation_entries ADD COLUMN recipient_agent TEXT;
`

const migrationV6 = `
CREATE TABLE execution_jobs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  workflow_run_id TEXT,
  payload_json TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  available_at TEXT NOT NULL,
  lease_owner TEXT,
  lease_expires_at TEXT,
  result_json TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE INDEX execution_jobs_status_available_idx ON execution_jobs(status, available_at);
CREATE INDEX execution_jobs_lease_expires_idx ON execution_jobs(lease_expires_at);
`

const migrationV7 = `
ALTER TABLE codex_sessions ADD COLUMN mapping_state TEXT NOT NULL DEFAULT 'active';
ALTER TABLE codex_sessions ADD COLUMN replacement_of_thread_id TEXT;
ALTER TABLE codex_sessions ADD COLUMN native_name TEXT;
ALTER TABLE codex_sessions ADD COLUMN native_cursor TEXT;
ALTER TABLE codex_sessions ADD COLUMN last_sync_at TEXT;
CREATE TABLE codex_sync_ledger (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  native_thread_id TEXT NOT NULL,
  native_turn_id TEXT NOT NULL,
  native_item_id TEXT NOT NULL,
  source TEXT NOT NULL CHECK(source IN ('harness', 'codex')),
  kind TEXT NOT NULL,
  conversation_entry_id TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(native_thread_id, native_turn_id, native_item_id)
);
CREATE INDEX codex_sync_ledger_conversation_idx
  ON codex_sync_ledger(conversation_id, created_at, id);
CREATE INDEX codex_sync_ledger_thread_idx
  ON codex_sync_ledger(native_thread_id, native_turn_id, native_item_id);
`

const migrationV8 = `
CREATE TABLE openclaw_runtime_sessions (
  conversation_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK(provider = 'openclaw'),
  session_namespace TEXT NOT NULL CHECK(session_namespace = 'harness-direct-v1'),
  state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'delivery_unknown')),
  session_key_fingerprint TEXT NOT NULL,
  bootstrap_delivered INTEGER NOT NULL DEFAULT 0 CHECK(bootstrap_delivered IN (0, 1)),
  last_delivered_entry_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(conversation_id, agent_id)
);
CREATE INDEX openclaw_runtime_sessions_updated_idx
  ON openclaw_runtime_sessions(updated_at);
`

const migrationV9 = `
ALTER TABLE conversations ADD COLUMN selected_model_id TEXT;
`

const migrationV10 = `
ALTER TABLE conversations ADD COLUMN selected_reasoning_intensity TEXT;
`

export function migrateHiveSchema(database: Database.Database) {
  const hasMigrationTable = database
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get() as { present: number } | undefined
  const currentVersion = hasMigrationTable
    ? (database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version
    : 0

  if (currentVersion > hiveSchemaVersion) {
    throw new Error(`Hive memory schema ${currentVersion} is newer than supported version ${hiveSchemaVersion}.`)
  }

  if (currentVersion < 1) {
    database.transaction(() => {
      database.exec(migrationV1)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(1, new Date().toISOString())
    })()
  }

  if (currentVersion < 2) {
    database.transaction(() => {
      database.exec(migrationV2)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(2, new Date().toISOString())
    })()
  }

  if (currentVersion < 3) {
    database.transaction(() => {
      database.exec(migrationV3)
      backfillConversationMetadata(database)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(3, new Date().toISOString())
    })()
  }

  if (currentVersion < 4) {
    database.transaction(() => {
      database.exec(migrationV4)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(4, new Date().toISOString())
    })()
  }

  if (currentVersion < 5) {
    database.transaction(() => {
      database.exec(migrationV5)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(5, new Date().toISOString())
    })()
  }

  if (currentVersion < 6) {
    database.transaction(() => {
      database.exec(migrationV6)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(6, new Date().toISOString())
    })()
  }

  if (currentVersion < 7) {
    database.transaction(() => {
      database.exec(migrationV7)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(7, new Date().toISOString())
    })()
  }

  if (currentVersion < 8) {
    database.transaction(() => {
      database.exec(migrationV8)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(8, new Date().toISOString())
    })()
  }

  if (currentVersion < 9) {
    database.transaction(() => {
      database.exec(migrationV9)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(9, new Date().toISOString())
    })()
  }

  if (currentVersion < 10) {
    database.transaction(() => {
      database.exec(migrationV10)
      database.prepare("INSERT INTO schema_migrations(version, applied_at) VALUES (?, ?)")
        .run(10, new Date().toISOString())
    })()
  }
}

function backfillConversationMetadata(database: Database.Database) {
  const rows = database.prepare(`
    SELECT
      entry.workflow_run_id AS conversationId,
      MIN(entry.created_at) AS createdAt,
      MAX(entry.created_at) AS updatedAt,
      (
        SELECT first_user.content
        FROM conversation_entries AS first_user
        WHERE first_user.workflow_run_id = entry.workflow_run_id
          AND first_user.role = 'user'
        ORDER BY first_user.created_at ASC, first_user.id ASC
        LIMIT 1
      ) AS firstUserContent
    FROM conversation_entries AS entry
    WHERE entry.workflow_run_id LIKE 'conversation:%'
      OR entry.workflow_run_id = :legacyConversationId
    GROUP BY entry.workflow_run_id
  `).all({ legacyConversationId }) as Array<{
    conversationId: string
    createdAt: string
    updatedAt: string
    firstUserContent: string | null
  }>

  const insert = database.prepare(`
    INSERT OR IGNORE INTO conversations(id, title, state, created_at, updated_at, archived_at)
    VALUES (?, ?, 'active', ?, ?, NULL)
  `)

  for (const row of rows) {
    insert.run(
      row.conversationId,
      normalizeConversationTitle(row.firstUserContent),
      row.createdAt,
      row.updatedAt
    )
  }
}

function normalizeConversationTitle(value?: string | null) {
  const normalized = value?.trim().replaceAll(/\s+/g, " ")
  if (!normalized) return "New conversation"
  return normalized.slice(0, 80)
}
