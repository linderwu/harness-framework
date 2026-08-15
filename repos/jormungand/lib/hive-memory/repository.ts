import type Database from "better-sqlite3"
import type { HiveDatabase } from "./database"
import type {
  AgentIdentity,
  CreateMemoryInput,
  FormalMemory,
  HiveEvent,
  MemoryCandidate,
  MemoryConflict,
  MemorySearchInput,
  MemoryTransitionInput,
  RecordMemoryUseInput,
  SubmitMemoryCandidate
} from "./types"

type MemoryRow = {
  id: string
  scope: FormalMemory["scope"]
  scope_id: string | null
  kind: FormalMemory["kind"]
  title: string
  content: string
  summary: string
  status: FormalMemory["status"]
  confidence: number
  importance: number
  source_agent: string
  created_at: string
  last_used_at: string | null
  expires_at: string | null
  supersedes_id: string | null
  sensitivity: FormalMemory["sensitivity"]
  version: number
  invalidation_conditions: string
}

type CandidateRow = {
  id: string
  observation: string
  proposed_scope: MemoryCandidate["proposedScope"]
  proposed_scope_id: string | null
  proposed_kind: MemoryCandidate["proposedKind"]
  confidence: number
  importance: number
  source_agent: string
  sensitivity: MemoryCandidate["sensitivity"]
  evidence_refs_json: string
  source_event_ids_json: string
  invalidation_conditions: string
  status: MemoryCandidate["status"]
  decision_reason: string | null
  created_at: string
  decided_at: string | null
}

export class HiveMemoryRepository {
  constructor(private readonly database: HiveDatabase) {}

  async submitCandidate(input: SubmitMemoryCandidate) {
    const candidate: MemoryCandidate = {
      ...input,
      id: crypto.randomUUID(),
      status: "candidate",
      createdAt: new Date().toISOString()
    }

    await this.database.transaction((connection) => {
      connection.prepare(`
        INSERT INTO memory_candidates (
          id, observation, proposed_scope, proposed_scope_id, proposed_kind,
          confidence, importance, source_agent, sensitivity, evidence_refs_json,
          source_event_ids_json, invalidation_conditions, status, decision_reason,
          created_at, decided_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
      `).run(
        candidate.id, candidate.observation, candidate.proposedScope,
        candidate.proposedScopeId ?? null, candidate.proposedKind,
        candidate.confidence, candidate.importance, candidate.sourceAgent,
        candidate.sensitivity, JSON.stringify(candidate.evidenceRefs),
        JSON.stringify(candidate.sourceEventIds), candidate.invalidationConditions,
        candidate.status, candidate.createdAt
      )
      this.insertEvent(connection, {
        eventType: "memory_candidate_submitted",
        actor: candidate.sourceAgent,
        payload: { candidateId: candidate.id, scope: candidate.proposedScope }
      })
    })
    return candidate
  }

  getCandidate(id: string) {
    const row = this.database.read((connection) =>
      connection.prepare("SELECT * FROM memory_candidates WHERE id = ?").get(id) as CandidateRow | undefined
    )
    return row ? candidateFromRow(row) : undefined
  }

  async decideCandidate(id: string, status: Exclude<MemoryCandidate["status"], "candidate">, reason: string) {
    const decidedAt = new Date().toISOString()
    await this.database.write((connection) => {
      connection.prepare(`
        UPDATE memory_candidates
        SET status = ?, decision_reason = ?, decided_at = ?
        WHERE id = ? AND status = 'candidate'
      `).run(status, reason, decidedAt, id)
    })
    const candidate = this.getCandidate(id)
    if (!candidate) throw new Error(`Memory candidate ${id} not found.`)
    return candidate
  }

  async createMemory(input: CreateMemoryInput) {
    const memory: FormalMemory = {
      id: crypto.randomUUID(),
      scope: input.scope,
      scopeId: input.scopeId,
      kind: input.kind,
      title: input.title.trim(),
      content: input.content.trim(),
      summary: input.summary.trim(),
      status: "active",
      confidence: clampScore(input.confidence),
      importance: clampScore(input.importance),
      sourceAgent: input.sourceAgent,
      sourceEventIds: unique(input.sourceEventIds),
      evidenceRefs: unique(input.evidenceRefs),
      createdAt: new Date().toISOString(),
      expiresAt: input.expiresAt,
      supersedesId: input.supersedesId,
      sensitivity: input.sensitivity,
      version: 1,
      invalidationConditions: input.invalidationConditions.trim()
    }

    await this.database.transaction((connection) => {
      insertMemory(connection, memory)
      this.insertEvent(connection, {
        eventType: "memory_activated",
        actor: input.actor,
        payload: { memoryId: memory.id, scope: memory.scope, version: memory.version }
      })
    })
    return memory
  }

  getMemory(id: string) {
    const row = this.database.read((connection) =>
      connection.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined
    )
    return row ? this.memoryFromRow(row) : undefined
  }

  listActiveMemories() {
    return this.database.read((connection) =>
      (connection.prepare("SELECT * FROM memories WHERE status = 'active'").all() as MemoryRow[])
        .map((row) => this.memoryFromRow(row))
    )
  }

  findExactActive(input: { content: string; scope: FormalMemory["scope"]; scopeId?: string; kind: FormalMemory["kind"] }) {
    const normalized = normalizeContent(input.content)
    return this.listActiveMemories().find((memory) =>
      memory.scope === input.scope &&
      memory.scopeId === input.scopeId &&
      memory.kind === input.kind &&
      normalizeContent(memory.content) === normalized
    )
  }

  findPotentialConflict(input: { content: string; scope: FormalMemory["scope"]; scopeId?: string; kind: FormalMemory["kind"] }) {
    const terms = tokenize(input.content)
    return this.listActiveMemories().find((memory) => {
      if (memory.scope !== input.scope || memory.scopeId !== input.scopeId || memory.kind !== input.kind) return false
      const memoryTerms = new Set(tokenize(memory.content))
      const overlap = terms.filter((term) => memoryTerms.has(term)).length
      return overlap >= Math.min(3, Math.max(1, Math.floor(terms.length / 2))) && normalizeContent(memory.content) !== normalizeContent(input.content)
    })
  }

  async mergeEvidence(memoryId: string, input: { actor: "codex" | "control_plane"; evidenceRefs: string[]; sourceEventIds: string[]; confidence: number; importance: number }) {
    await this.database.transaction((connection) => {
      const memory = this.requireMemoryFromConnection(connection, memoryId)
      for (const ref of unique(input.evidenceRefs)) {
        connection.prepare("INSERT OR IGNORE INTO memory_evidence(memory_id, evidence_ref) VALUES (?, ?)").run(memoryId, ref)
      }
      for (const eventId of unique(input.sourceEventIds)) {
        connection.prepare("INSERT OR IGNORE INTO memory_sources(memory_id, event_id) VALUES (?, ?)").run(memoryId, eventId)
      }
      connection.prepare(`
        UPDATE memories SET confidence = ?, importance = ?, version = version + 1 WHERE id = ?
      `).run(Math.max(memory.confidence, input.confidence), Math.max(memory.importance, input.importance), memoryId)
      this.insertEvent(connection, {
        eventType: "memory_evidence_merged",
        actor: input.actor,
        payload: { memoryId, oldVersion: memory.version, newVersion: memory.version + 1 }
      })
    })
    return this.requireMemory(memoryId)
  }

  async transition(input: MemoryTransitionInput) {
    await this.database.transaction((connection) => {
      const memory = this.requireMemoryFromConnection(connection, input.memoryId)
      for (const ref of unique(input.evidenceRefs)) {
        connection.prepare("INSERT OR IGNORE INTO memory_evidence(memory_id, evidence_ref) VALUES (?, ?)").run(input.memoryId, ref)
      }
      connection.prepare(`
        UPDATE memories
        SET status = ?, version = version + 1, supersedes_id = COALESCE(?, supersedes_id)
        WHERE id = ?
      `).run(input.status, input.supersededById ?? null, input.memoryId)
      this.insertEvent(connection, {
        eventType: `memory_${input.status}`,
        actor: input.actor,
        payload: {
          memoryId: input.memoryId,
          reason: input.reason,
          evidenceRefs: input.evidenceRefs,
          oldVersion: memory.version,
          newVersion: memory.version + 1
        }
      })
    })
    return this.requireMemory(input.memoryId)
  }

  search(input: MemorySearchInput) {
    if (input.allowedSensitivity.length === 0) return []
    const query = toFtsQuery(input.query)
    const sensitivityPlaceholders = input.allowedSensitivity.map(() => "?").join(", ")
    const scopeClauses = ["m.scope = 'global'"]
    const scopeParameters: string[] = []
    if (input.projectId) {
      scopeClauses.push("(m.scope = 'project' AND m.scope_id = ?)")
      scopeParameters.push(input.projectId)
    }
    if (input.agentId) {
      scopeClauses.push("(m.scope = 'agent' AND m.scope_id = ?)")
      scopeParameters.push(input.agentId)
    }
    if (input.taskId) {
      scopeClauses.push("(m.scope = 'task' AND m.scope_id = ?)")
      scopeParameters.push(input.taskId)
    }
    const join = query ? "JOIN memories_fts f ON f.memory_id = m.id" : ""
    const match = query ? "AND memories_fts MATCH ?" : ""
    const parameters = [
      ...input.allowedSensitivity,
      ...scopeParameters,
      ...(query ? [query] : []),
      Math.max(1, input.limit ?? 50)
    ]

    return this.database.read((connection) =>
      (connection.prepare(`
        SELECT m.* FROM memories m ${join}
        WHERE m.status = 'active'
          AND m.sensitivity IN (${sensitivityPlaceholders})
          AND (${scopeClauses.join(" OR ")})
          ${match}
        ORDER BY m.importance DESC, m.confidence DESC, m.created_at DESC, m.id ASC
        LIMIT ?
      `).all(...parameters) as MemoryRow[]).map((row) => this.memoryFromRow(row))
    )
  }

  async recordUse(input: RecordMemoryUseInput) {
    await this.database.transaction((connection) => {
      connection.prepare(`
        INSERT INTO memory_uses(id, memory_id, workflow_run_id, task_id, context_pack_id, outcome, used_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(crypto.randomUUID(), input.memoryId, input.workflowRunId, input.taskId ?? null, input.contextPackId, input.outcome ?? null, new Date().toISOString())
      connection.prepare("UPDATE memories SET last_used_at = ? WHERE id = ?").run(new Date().toISOString(), input.memoryId)
    })
  }

  listMemoryUses(contextPackId?: string) {
    return this.database.read((connection) => {
      const rows = connection.prepare(`
        SELECT memory_id, workflow_run_id, task_id, context_pack_id, outcome, used_at
        FROM memory_uses
        WHERE (? IS NULL OR context_pack_id = ?)
        ORDER BY used_at ASC, id ASC
      `).all(contextPackId ?? null, contextPackId ?? null) as Array<{
        memory_id: string; workflow_run_id: string; task_id: string | null;
        context_pack_id: string; outcome: string | null; used_at: string
      }>
      return rows.map((row) => ({
        memoryId: row.memory_id,
        workflowRunId: row.workflow_run_id,
        taskId: row.task_id ?? undefined,
        contextPackId: row.context_pack_id,
        outcome: row.outcome ?? undefined,
        usedAt: row.used_at
      }))
    })
  }

  async createConflict(input: { leftMemoryId: string; rightMemoryId: string; verificationTaskId: string }) {
    const conflict: MemoryConflict = {
      id: crypto.randomUUID(),
      leftMemoryId: input.leftMemoryId,
      rightMemoryId: input.rightMemoryId,
      status: "open",
      verificationTaskId: input.verificationTaskId,
      createdAt: new Date().toISOString()
    }
    await this.database.transaction((connection) => {
      connection.prepare(`
        INSERT INTO memory_conflicts(id, left_memory_id, right_memory_id, status, verification_task_id, created_at, resolved_at)
        VALUES (?, ?, ?, ?, ?, ?, NULL)
      `).run(conflict.id, conflict.leftMemoryId, conflict.rightMemoryId, conflict.status, conflict.verificationTaskId, conflict.createdAt)
      this.insertEvent(connection, {
        eventType: "memory_conflict_created",
        actor: "codex",
        taskId: input.verificationTaskId,
        payload: { ...conflict }
      })
    })
    return conflict
  }

  listOpenConflicts(memoryIds?: string[]) {
    return this.database.read((connection) => {
      const rows = connection.prepare("SELECT * FROM memory_conflicts WHERE status = 'open' ORDER BY created_at ASC").all() as Array<{
        id: string; left_memory_id: string; right_memory_id: string; status: "open"; verification_task_id: string | null; created_at: string; resolved_at: string | null
      }>
      return rows
        .filter((row) => !memoryIds || memoryIds.includes(row.left_memory_id) || memoryIds.includes(row.right_memory_id))
        .map((row) => ({
          id: row.id,
          leftMemoryId: row.left_memory_id,
          rightMemoryId: row.right_memory_id,
          status: row.status,
          verificationTaskId: row.verification_task_id ?? undefined,
          createdAt: row.created_at,
          resolvedAt: row.resolved_at ?? undefined
        }))
    })
  }

  listEvents(filter: { memoryId?: string; workflowRunId?: string } = {}) {
    return this.database.read((connection) => {
      const rows = connection.prepare(`
        SELECT * FROM hive_events
        WHERE (? IS NULL OR workflow_run_id = ?)
        ORDER BY created_at ASC, id ASC
      `).all(filter.workflowRunId ?? null, filter.workflowRunId ?? null) as Array<{
        id: string; event_type: string; actor: string; workflow_run_id: string | null; task_id: string | null; payload_json: string; idempotency_key: string | null; created_at: string
      }>
      return rows.map(eventFromRow).filter((event) => !filter.memoryId || event.payload.memoryId === filter.memoryId)
    })
  }

  async upsertAgentIdentity(input: { actor: string; identity: AgentIdentity }) {
    if (input.actor !== "control_plane") throw new Error("Only the control plane can update agent identity permissions.")
    await this.database.transaction((connection) => {
      const identity = input.identity
      connection.prepare(`
        INSERT INTO agent_identities(
          agent_id, role, capabilities_json, tools_json, permissions_json,
          prohibitions_json, collaboration_preferences_json, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(agent_id) DO UPDATE SET
          role = excluded.role,
          capabilities_json = excluded.capabilities_json,
          tools_json = excluded.tools_json,
          permissions_json = excluded.permissions_json,
          prohibitions_json = excluded.prohibitions_json,
          collaboration_preferences_json = excluded.collaboration_preferences_json,
          updated_at = excluded.updated_at
      `).run(
        identity.agentId, identity.role, JSON.stringify(identity.capabilities),
        JSON.stringify(identity.tools), JSON.stringify(identity.permissions),
        JSON.stringify(identity.prohibitions), JSON.stringify(identity.collaborationPreferences),
        identity.updatedAt
      )
      this.insertEvent(connection, {
        eventType: "agent_identity_updated",
        actor: input.actor,
        payload: { agentId: identity.agentId }
      })
    })
    return input.identity
  }

  getAgentIdentity(agentId: string) {
    return this.database.read((connection) => {
      const row = connection.prepare("SELECT * FROM agent_identities WHERE agent_id = ?").get(agentId) as {
        agent_id: string; role: string; capabilities_json: string; tools_json: string; permissions_json: string; prohibitions_json: string; collaboration_preferences_json: string; updated_at: string
      } | undefined
      return row ? {
        agentId: row.agent_id,
        role: row.role,
        capabilities: parseStringArray(row.capabilities_json),
        tools: parseStringArray(row.tools_json),
        permissions: parseStringArray(row.permissions_json),
        prohibitions: parseStringArray(row.prohibitions_json),
        collaborationPreferences: parseStringArray(row.collaboration_preferences_json),
        updatedAt: row.updated_at
      } satisfies AgentIdentity : undefined
    })
  }

  private requireMemory(id: string) {
    const memory = this.getMemory(id)
    if (!memory) throw new Error(`Memory ${id} not found.`)
    return memory
  }

  private requireMemoryFromConnection(connection: Database.Database, id: string) {
    const row = connection.prepare("SELECT * FROM memories WHERE id = ?").get(id) as MemoryRow | undefined
    if (!row) throw new Error(`Memory ${id} not found.`)
    return this.memoryFromRow(row, connection)
  }

  private memoryFromRow(row: MemoryRow, providedConnection?: Database.Database): FormalMemory {
    const load = (connection: Database.Database) => {
      const sourceEventIds = (connection.prepare("SELECT event_id FROM memory_sources WHERE memory_id = ? ORDER BY event_id").all(row.id) as Array<{ event_id: string }>).map((item) => item.event_id)
      const evidenceRefs = (connection.prepare("SELECT evidence_ref FROM memory_evidence WHERE memory_id = ? ORDER BY evidence_ref").all(row.id) as Array<{ evidence_ref: string }>).map((item) => item.evidence_ref)
      return memoryFromRow(row, sourceEventIds, evidenceRefs)
    }
    return providedConnection ? load(providedConnection) : this.database.read(load)
  }

  private insertEvent(connection: Database.Database, input: {
    eventType: string
    actor: string
    workflowRunId?: string
    taskId?: string
    payload: Record<string, unknown>
    idempotencyKey?: string
  }) {
    connection.prepare(`
      INSERT INTO hive_events(id, event_type, actor, workflow_run_id, task_id, payload_json, idempotency_key, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      crypto.randomUUID(), input.eventType, input.actor,
      input.workflowRunId ?? null, input.taskId ?? null,
      JSON.stringify(input.payload), input.idempotencyKey ?? null,
      new Date().toISOString()
    )
  }
}

export function createHiveMemoryRepository(database: HiveDatabase) {
  return new HiveMemoryRepository(database)
}

function insertMemory(connection: Database.Database, memory: FormalMemory) {
  connection.prepare(`
    INSERT INTO memories(
      id, scope, scope_id, kind, title, content, summary, status, confidence,
      importance, source_agent, created_at, last_used_at, expires_at,
      supersedes_id, sensitivity, version, invalidation_conditions
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
  `).run(
    memory.id, memory.scope, memory.scopeId ?? null, memory.kind,
    memory.title, memory.content, memory.summary, memory.status,
    memory.confidence, memory.importance, memory.sourceAgent, memory.createdAt,
    memory.expiresAt ?? null, memory.supersedesId ?? null, memory.sensitivity,
    memory.version, memory.invalidationConditions
  )
  connection.prepare("INSERT INTO memories_fts(memory_id, title, summary, content) VALUES (?, ?, ?, ?)")
    .run(memory.id, memory.title, memory.summary, memory.content)
  for (const eventId of memory.sourceEventIds) {
    connection.prepare("INSERT INTO memory_sources(memory_id, event_id) VALUES (?, ?)").run(memory.id, eventId)
  }
  for (const evidenceRef of memory.evidenceRefs) {
    connection.prepare("INSERT INTO memory_evidence(memory_id, evidence_ref) VALUES (?, ?)").run(memory.id, evidenceRef)
  }
}

function memoryFromRow(row: MemoryRow, sourceEventIds: string[], evidenceRefs: string[]): FormalMemory {
  return {
    id: row.id,
    scope: row.scope,
    scopeId: row.scope_id ?? undefined,
    kind: row.kind,
    title: row.title,
    content: row.content,
    summary: row.summary,
    status: row.status,
    confidence: row.confidence,
    importance: row.importance,
    sourceAgent: row.source_agent,
    sourceEventIds,
    evidenceRefs,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    supersedesId: row.supersedes_id ?? undefined,
    sensitivity: row.sensitivity,
    version: row.version,
    invalidationConditions: row.invalidation_conditions
  }
}

function candidateFromRow(row: CandidateRow): MemoryCandidate {
  return {
    id: row.id,
    observation: row.observation,
    proposedScope: row.proposed_scope,
    proposedScopeId: row.proposed_scope_id ?? undefined,
    proposedKind: row.proposed_kind,
    confidence: row.confidence,
    importance: row.importance,
    sourceAgent: row.source_agent,
    sensitivity: row.sensitivity,
    evidenceRefs: parseStringArray(row.evidence_refs_json),
    sourceEventIds: parseStringArray(row.source_event_ids_json),
    invalidationConditions: row.invalidation_conditions,
    status: row.status,
    decisionReason: row.decision_reason ?? undefined,
    createdAt: row.created_at,
    decidedAt: row.decided_at ?? undefined
  }
}

function eventFromRow(row: { id: string; event_type: string; actor: string; workflow_run_id: string | null; task_id: string | null; payload_json: string; idempotency_key: string | null; created_at: string }): HiveEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    actor: row.actor,
    workflowRunId: row.workflow_run_id ?? undefined,
    taskId: row.task_id ?? undefined,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    idempotencyKey: row.idempotency_key ?? undefined,
    createdAt: row.created_at
  }
}

function parseStringArray(value: string) {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
}

function clampScore(value: number) {
  return Math.min(1, Math.max(0, value))
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}

export function normalizeContent(value: string) {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase()
}

function tokenize(value: string) {
  return normalizeContent(value).split(/[^a-z0-9_]+/).filter((token) => token.length > 2)
}

function toFtsQuery(value: string) {
  return tokenize(value).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ")
}
