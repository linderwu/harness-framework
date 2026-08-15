import type Database from "better-sqlite3"

export const hiveSchemaVersion = 1

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
}
