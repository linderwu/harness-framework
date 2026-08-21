import type Database from "better-sqlite3"
import type { HiveDatabase } from "./database"
import type {
  A2AEventRecord,
  A2AMessageRecord,
  A2ATaskRecord,
  AgentIdentity,
  AppendA2AEventInput,
  ConversationEntry,
  ConversationMetadata,
  ConversationState,
  ConversationSummary,
  CreateA2ATaskInput,
  CreateExecutionJobInput,
  CreateMemoryInput,
  FormalMemory,
  HiveEvent,
  InsertA2AMessageInput,
  MemoryCandidate,
  MemoryConflict,
  MemorySearchInput,
  MemoryTransitionInput,
  RecordMemoryUseInput,
  ClaimExecutionJobInput,
  ClaimNextExecutionJobInput,
  CompleteExecutionJobInput,
  CancelExecutionJobInput,
  RecoverExpiredExecutionJobsInput,
  RequeueExecutionJobInput,
  ExecutionJob,
  FailExecutionJobInput,
  SubmitMemoryCandidate,
  UpdateA2ATaskInput
} from "./types"
import type { AgentKind, ManagerCheckpoint, ManagerProposal } from "../types"
import {
  canonicalizeJson,
  normalizeA2ATaskStatus,
  redactA2AFrame,
  sha256Json
} from "../a2a-runtime"
import {
  cancelQueuedExecutionJob,
  claimQueuedExecutionJob,
  completeRunningExecutionJob,
  createQueuedExecutionJob,
  failRunningExecutionJob,
  requeueFailedExecutionJob
} from "../execution-jobs"
import { legacyConversationId } from "../conversation-identity"

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

type ConversationRow = {
  id: string
  workflow_run_id: string
  task_id: string | null
  role: ConversationEntry["role"]
  agent_id: ConversationEntry["agentId"] | null
  recipient_agent: ConversationEntry["recipientAgent"] | null
  content: string
  importance: ConversationEntry["importance"]
  status: ConversationEntry["status"]
  reply_to_id: string | null
  artifact_ids_json: string
  memory_ids_json: string
  idempotency_key: string
  created_at: string
}

type ConversationMetadataRow = {
  id: string
  title: string
  state: ConversationState
  created_at: string
  updated_at: string
  archived_at: string | null
}

type ConversationSummaryRow = {
  conversationId: string
  title: string
  state: ConversationState
  messageCount: number
  latestMessageAt: string | null
  latestMessage: string | null
}

interface CreateInboundA2ARequestInput {
  workflowRunId?: string
  contextId: string
  fromAgent: string
  toAgent: string
  requestMessageId: string
  idempotencyKey: string
  protocolVersion: string
  method: string
  transport: string
  requestFrame: unknown
  actor: string
  queuedEventPayload: Record<string, unknown>
}

type CreateInboundA2ARequestResult =
  | { task: A2ATaskRecord; inserted: false }
  | {
      task: A2ATaskRecord
      message: A2AMessageRecord
      queuedEvent: A2AEventRecord
      inserted: true
    }

type A2ATaskRow = {
  id: string
  workflow_run_id: string | null
  context_id: string
  remote_task_id: string | null
  from_agent: string
  to_agent: string
  status: string
  request_message_id: string
  idempotency_key: string
  error_code: string | null
  error_message: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
}

type A2AMessageRow = {
  id: string
  task_id: string | null
  context_id: string
  parent_message_id: string | null
  direction: A2AMessageRecord["direction"]
  from_agent: string
  to_agent: string
  protocol_version: string
  method: string
  transport: string
  idempotency_key: string | null
  request_json: string
  response_json: string | null
  request_sha256: string
  response_sha256: string | null
  created_at: string
  sent_at: string | null
  received_at: string | null
}

type A2AEventRow = {
  id: string
  task_id: string
  message_id: string | null
  sequence: number
  event_type: A2AEventRecord["eventType"]
  actor: string
  payload_json: string
  created_at: string
}

type ExecutionJobRow = {
  id: string
  kind: string
  workflow_run_id: string | null
  payload_json: string
  idempotency_key: string
  status: ExecutionJob["status"]
  attempt_count: number
  available_at: string
  lease_owner: string | null
  lease_expires_at: string | null
  result_json: string | null
  last_error: string | null
  created_at: string
  updated_at: string
  completed_at: string | null
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

  async createA2ATask(input: CreateA2ATaskInput) {
    const now = new Date().toISOString()
    const task: A2ATaskRecord = {
      id: crypto.randomUUID(),
      workflowRunId: input.workflowRunId,
      contextId: input.contextId,
      remoteTaskId: input.remoteTaskId,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      status: normalizeA2ATaskStatus(input.status),
      requestMessageId: input.requestMessageId,
      idempotencyKey: input.idempotencyKey,
      errorCode: input.errorCode,
      errorMessage: input.errorMessage,
      createdAt: now,
      updatedAt: now,
      completedAt: input.completedAt
    }

    return this.database.transaction((connection) => {
      const existing = connection.prepare(`
        SELECT * FROM a2a_tasks WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as A2ATaskRow | undefined
      if (existing) {
        return { task: a2aTaskFromRow(existing), inserted: false }
      }

      connection.prepare(`
        INSERT INTO a2a_tasks(
          id, workflow_run_id, context_id, remote_task_id, from_agent, to_agent,
          status, request_message_id, idempotency_key, error_code, error_message,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.workflowRunId ?? null,
        task.contextId,
        task.remoteTaskId ?? null,
        task.fromAgent,
        task.toAgent,
        task.status,
        task.requestMessageId,
        task.idempotencyKey,
        task.errorCode ?? null,
        task.errorMessage ?? null,
        task.createdAt,
        task.updatedAt,
        task.completedAt ?? null
      )

      return { task, inserted: true }
    })
  }

  async createInboundA2ARequest(
    input: CreateInboundA2ARequestInput
  ): Promise<CreateInboundA2ARequestResult> {
    const createdAt = new Date().toISOString()
    const requestFrame = redactA2AFrame(input.requestFrame)
    const task: A2ATaskRecord = {
      id: crypto.randomUUID(),
      workflowRunId: input.workflowRunId,
      contextId: input.contextId,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      status: "submitted",
      requestMessageId: input.requestMessageId,
      idempotencyKey: input.idempotencyKey,
      createdAt,
      updatedAt: createdAt
    }
    const message: A2AMessageRecord = {
      id: crypto.randomUUID(),
      taskId: task.id,
      contextId: task.contextId,
      direction: "inbound",
      fromAgent: task.fromAgent,
      toAgent: task.toAgent,
      protocolVersion: input.protocolVersion,
      method: input.method,
      transport: input.transport,
      idempotencyKey: task.idempotencyKey,
      requestJson: canonicalizeJson(requestFrame),
      requestSha256: sha256Json(requestFrame),
      createdAt
    }
    const queuedEvent: A2AEventRecord = {
      id: crypto.randomUUID(),
      taskId: task.id,
      messageId: message.id,
      sequence: 1,
      eventType: "message_queued",
      actor: input.actor,
      payload: redactA2AFrame(input.queuedEventPayload),
      createdAt
    }

    return this.database.transaction((connection) => {
      const existing = connection.prepare(`
        SELECT * FROM a2a_tasks WHERE idempotency_key = ?
      `).get(input.idempotencyKey) as A2ATaskRow | undefined
      if (existing) {
        return { task: a2aTaskFromRow(existing), inserted: false }
      }

      connection.prepare(`
        INSERT INTO a2a_tasks(
          id, workflow_run_id, context_id, remote_task_id, from_agent, to_agent,
          status, request_message_id, idempotency_key, error_code, error_message,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.workflowRunId ?? null,
        task.contextId,
        null,
        task.fromAgent,
        task.toAgent,
        task.status,
        task.requestMessageId,
        task.idempotencyKey,
        null,
        null,
        task.createdAt,
        task.updatedAt,
        null
      )

      connection.prepare(`
        INSERT INTO a2a_messages(
          id, task_id, context_id, parent_message_id, direction, from_agent,
          to_agent, protocol_version, method, transport, idempotency_key,
          request_json, response_json, request_sha256, response_sha256,
          created_at, sent_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.taskId ?? null,
        message.contextId,
        null,
        message.direction,
        message.fromAgent,
        message.toAgent,
        message.protocolVersion,
        message.method,
        message.transport,
        message.idempotencyKey ?? null,
        message.requestJson,
        null,
        message.requestSha256,
        null,
        message.createdAt,
        null,
        null
      )

      connection.prepare(`
        INSERT INTO a2a_events(
          id, task_id, message_id, sequence, event_type, actor, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        queuedEvent.id,
        queuedEvent.taskId,
        queuedEvent.messageId ?? null,
        queuedEvent.sequence,
        queuedEvent.eventType,
        queuedEvent.actor,
        JSON.stringify(queuedEvent.payload),
        queuedEvent.createdAt
      )

      return { task, message, queuedEvent, inserted: true }
    })
  }

  async insertA2AMessage(input: InsertA2AMessageInput) {
    const createdAt = new Date().toISOString()
    const requestFrame = redactA2AFrame(input.requestFrame)
    const responseFrame = input.responseFrame === undefined
      ? undefined
      : redactA2AFrame(input.responseFrame)
    const message: A2AMessageRecord = {
      id: crypto.randomUUID(),
      taskId: input.taskId,
      contextId: input.contextId,
      parentMessageId: input.parentMessageId,
      direction: input.direction,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      protocolVersion: input.protocolVersion,
      method: input.method,
      transport: input.transport,
      idempotencyKey: input.idempotencyKey,
      requestJson: canonicalizeJson(requestFrame),
      responseJson: responseFrame === undefined ? undefined : canonicalizeJson(responseFrame),
      requestSha256: sha256Json(requestFrame),
      responseSha256: responseFrame === undefined ? undefined : sha256Json(responseFrame),
      createdAt,
      sentAt: input.sentAt,
      receivedAt: input.receivedAt
    }

    await this.database.write((connection) => {
      connection.prepare(`
        INSERT INTO a2a_messages(
          id, task_id, context_id, parent_message_id, direction, from_agent,
          to_agent, protocol_version, method, transport, idempotency_key,
          request_json, response_json, request_sha256, response_sha256,
          created_at, sent_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        message.id,
        message.taskId ?? null,
        message.contextId,
        message.parentMessageId ?? null,
        message.direction,
        message.fromAgent,
        message.toAgent,
        message.protocolVersion,
        message.method,
        message.transport,
        message.idempotencyKey ?? null,
        message.requestJson,
        message.responseJson ?? null,
        message.requestSha256,
        message.responseSha256 ?? null,
        message.createdAt,
        message.sentAt ?? null,
        message.receivedAt ?? null
      )
    })

    return message
  }

  async updateA2AMessageResponse(input: {
    id: string
    responseFrame: unknown
    receivedAt?: string
  }) {
    const responseFrame = redactA2AFrame(input.responseFrame)
    const responseJson = canonicalizeJson(responseFrame)
    const responseSha256 = sha256Json(responseFrame)
    await this.database.write((connection) => {
      connection.prepare(`
        UPDATE a2a_messages SET
          response_json = ?,
          response_sha256 = ?,
          received_at = COALESCE(?, received_at)
        WHERE id = ?
      `).run(
        responseJson,
        responseSha256,
        input.receivedAt ?? null,
        input.id
      )
    })
    return this.database.read((connection) => {
      const row = connection.prepare(`
        SELECT * FROM a2a_messages WHERE id = ?
      `).get(input.id) as A2AMessageRow | undefined
      if (!row) {
        throw new Error(`A2A message ${input.id} not found.`)
      }
      return a2aMessageFromRow(row)
    })
  }

  async appendA2AEvent(input: AppendA2AEventInput) {
    return this.database.transaction((connection) => {
      const payload = redactA2AFrame(input.payload)
      const sequence = ((connection.prepare(`
        SELECT COALESCE(MAX(sequence), 0) AS sequence
        FROM a2a_events
        WHERE task_id = ?
      `).get(input.taskId) as { sequence: number }).sequence) + 1
      const event: A2AEventRecord = {
        id: crypto.randomUUID(),
        taskId: input.taskId,
        messageId: input.messageId,
        sequence,
        eventType: input.eventType,
        actor: input.actor,
        payload,
        createdAt: new Date().toISOString()
      }

      connection.prepare(`
        INSERT INTO a2a_events(
          id, task_id, message_id, sequence, event_type, actor, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        event.id,
        event.taskId,
        event.messageId ?? null,
        event.sequence,
        event.eventType,
        event.actor,
        JSON.stringify(event.payload),
        event.createdAt
      )

      return event
    })
  }

  async updateA2ATask(input: UpdateA2ATaskInput) {
    return this.database.transaction((connection) => {
      connection.prepare(`
        UPDATE a2a_tasks SET
          remote_task_id = COALESCE(?, remote_task_id),
          status = COALESCE(?, status),
          error_code = COALESCE(?, error_code),
          error_message = COALESCE(?, error_message),
          updated_at = ?,
          completed_at = COALESCE(?, completed_at)
        WHERE id = ?
      `).run(
        input.remoteTaskId ?? null,
        input.status ? normalizeA2ATaskStatus(input.status) : null,
        input.errorCode ?? null,
        input.errorMessage ?? null,
        new Date().toISOString(),
        input.completedAt ?? null,
        input.id
      )
      const row = connection.prepare(`
        SELECT * FROM a2a_tasks WHERE id = ?
      `).get(input.id) as A2ATaskRow | undefined
      if (!row) {
        throw new Error(`A2A task ${input.id} not found.`)
      }
      return a2aTaskFromRow(row)
    })
  }

  getA2ATask(id: string) {
    return this.database.read((connection) => {
      const row = connection.prepare(`
        SELECT * FROM a2a_tasks WHERE id = ?
      `).get(id) as A2ATaskRow | undefined
      return row ? a2aTaskFromRow(row) : undefined
    })
  }

  getA2ATaskByIdempotencyKey(key: string) {
    return this.database.read((connection) => {
      const row = connection.prepare(`
        SELECT * FROM a2a_tasks WHERE idempotency_key = ?
      `).get(key) as A2ATaskRow | undefined
      return row ? a2aTaskFromRow(row) : undefined
    })
  }

  listA2AEvents(taskId: string) {
    return this.database.read((connection) =>
      (connection.prepare(`
        SELECT * FROM a2a_events
        WHERE task_id = ?
        ORDER BY sequence ASC, created_at ASC, id ASC
      `).all(taskId) as A2AEventRow[]).map(a2aEventFromRow)
    )
  }

  listA2AMessages(taskId: string) {
    return this.database.read((connection) =>
      (connection.prepare(`
        SELECT * FROM a2a_messages
        WHERE task_id = ?
        ORDER BY created_at ASC, id ASC
      `).all(taskId) as A2AMessageRow[]).map(a2aMessageFromRow)
    )
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

  async saveManagerCycle(input: {
    workflowRunId: string
    proposal: ManagerProposal
    acceptedActions: ManagerProposal["proposed_actions"]
    rejectedActions: Array<{ action: unknown; reason: string }>
    checkpoint: ManagerCheckpoint
  }) {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    return this.database.transaction((connection) => {
      const cycle = ((connection.prepare(`
        SELECT COALESCE(MAX(cycle), 0) AS cycle FROM manager_checkpoints WHERE workflow_run_id = ?
      `).get(input.workflowRunId) as { cycle: number }).cycle) + 1
      connection.prepare(`
        INSERT INTO manager_decisions(
          id, workflow_run_id, observation, decision, reason, proposal_json,
          accepted_actions_json, rejected_actions_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        crypto.randomUUID(), input.workflowRunId, input.proposal.observation,
        input.proposal.decision, input.proposal.reason, JSON.stringify(input.proposal),
        JSON.stringify(input.acceptedActions), JSON.stringify(input.rejectedActions), createdAt
      )
      connection.prepare(`
        INSERT INTO manager_checkpoints(
          id, workflow_run_id, cycle, checkpoint_json, next_wake_condition, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        id, input.workflowRunId, cycle, JSON.stringify(input.checkpoint),
        input.checkpoint.nextWakeCondition, createdAt
      )
      this.insertEvent(connection, {
        eventType: "manager_cycle_checkpointed",
        actor: "codex",
        workflowRunId: input.workflowRunId,
        payload: { checkpointId: id, cycle }
      })
      return { id, workflowRunId: input.workflowRunId, cycle, checkpoint: input.checkpoint, createdAt }
    })
  }

  getLatestManagerCheckpoint(workflowRunId: string) {
    return this.database.read((connection) => {
      const row = connection.prepare(`
        SELECT id, workflow_run_id, cycle, checkpoint_json, created_at
        FROM manager_checkpoints
        WHERE workflow_run_id = ?
        ORDER BY cycle DESC LIMIT 1
      `).get(workflowRunId) as {
        id: string; workflow_run_id: string; cycle: number; checkpoint_json: string; created_at: string
      } | undefined
      return row ? {
        id: row.id,
        workflowRunId: row.workflow_run_id,
        cycle: row.cycle,
        checkpoint: JSON.parse(row.checkpoint_json) as ManagerCheckpoint,
        createdAt: row.created_at
      } : undefined
    })
  }

  async enqueueManagerWake(input: { workflowRunId: string; reason: string; idempotencyKey: string }) {
    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    return this.database.write((connection) => {
      const result = connection.prepare(`
        INSERT OR IGNORE INTO manager_wakes(
          id, workflow_run_id, reason, idempotency_key, status, created_at, processed_at
        ) VALUES (?, ?, ?, ?, 'pending', ?, NULL)
      `).run(id, input.workflowRunId, input.reason, input.idempotencyKey, createdAt)
      return result.changes > 0
    })
  }

  listManagerWakes(workflowRunId: string) {
    return this.database.read((connection) =>
      (connection.prepare(`
        SELECT * FROM manager_wakes WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC
      `).all(workflowRunId) as Array<{
        id: string; workflow_run_id: string; reason: string; idempotency_key: string;
        status: "pending" | "processing" | "processed"; created_at: string; processed_at: string | null
      }>).map((row) => ({
        id: row.id,
        workflowRunId: row.workflow_run_id,
        reason: row.reason,
        idempotencyKey: row.idempotency_key,
        status: row.status,
        createdAt: row.created_at,
        processedAt: row.processed_at ?? undefined
      }))
    )
  }

  getNextPendingManagerWake(workflowRunId: string) {
    return this.listManagerWakes(workflowRunId).find((wake) => wake.status === "pending")
  }

  async markManagerWake(id: string, status: "processing" | "processed") {
    await this.database.write((connection) => {
      connection.prepare(`
        UPDATE manager_wakes SET status = ?, processed_at = ? WHERE id = ?
      `).run(status, status === "processed" ? new Date().toISOString() : null, id)
    })
  }

  async appendEvent(input: {
    eventType: string
    actor: string
    workflowRunId?: string
    taskId?: string
    payload: Record<string, unknown>
    idempotencyKey?: string
  }) {
    await this.database.write((connection) => this.insertEvent(connection, input))
  }

  async insertConversation(input: Omit<ConversationEntry, "id" | "createdAt">) {
    const entry: ConversationEntry = {
      ...input,
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString()
    }
    const inserted = await this.database.transaction((connection) => {
      this.ensureConversationMetadata(connection, input.workflowRunId, deriveConversationTitle(input.role, input.content), entry.createdAt)
      const result = connection.prepare(`
        INSERT OR IGNORE INTO conversation_entries(
          id, workflow_run_id, task_id, role, agent_id, recipient_agent, content, importance,
          status, reply_to_id, artifact_ids_json, memory_ids_json,
          idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        entry.id, entry.workflowRunId, entry.taskId ?? null, entry.role,
        entry.agentId ?? null, entry.recipientAgent ?? null,
        entry.content, entry.importance, entry.status,
        entry.replyToId ?? null, JSON.stringify(entry.artifactIds),
        JSON.stringify(entry.memoryIds), entry.idempotencyKey, entry.createdAt
      )
      if (result.changes > 0) {
        this.touchConversationMetadata(connection, input.workflowRunId, entry.createdAt)
      }
      return result.changes > 0
    })
    return {
      entry: inserted ? entry : this.getConversationByIdempotencyKey(input.idempotencyKey)!,
      inserted
    }
  }

  listConversation(workflowRunId: string) {
    return this.database.read((connection) =>
      (connection.prepare(`
        SELECT * FROM conversation_entries
        WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC
      `).all(workflowRunId) as ConversationRow[]).map(conversationFromRow)
    )
  }

  listUnboundConversations() {
    return this.listConversationSummaries({ includeArchived: true }).map((summary) => ({
      conversationId: summary.conversationId,
      messageCount: summary.messageCount,
      latestMessageAt: summary.latestMessageAt,
      latestMessage: summary.latestMessage
    }))
  }

  async moveConversation(sourceWorkflowRunId: string, targetWorkflowRunId: string) {
    await this.database.transaction((connection) => {
      connection.prepare(`
        UPDATE conversation_entries SET workflow_run_id = ?
        WHERE workflow_run_id = ?
      `).run(targetWorkflowRunId, sourceWorkflowRunId)
      this.moveConversationMetadata(connection, sourceWorkflowRunId, targetWorkflowRunId)
    })
    return this.listConversation(targetWorkflowRunId)
  }

  getConversationByIdempotencyKey(idempotencyKey: string) {
    return this.database.read((connection) => {
      const row = connection.prepare(`
        SELECT * FROM conversation_entries WHERE idempotency_key = ?
      `).get(idempotencyKey) as ConversationRow | undefined
      return row ? conversationFromRow(row) : undefined
    })
  }

  getConversationEntry(id: string) {
    return this.database.read((connection) => {
      const row = connection.prepare("SELECT * FROM conversation_entries WHERE id = ?")
        .get(id) as ConversationRow | undefined
      return row ? conversationFromRow(row) : undefined
    })
  }

  async updateConversation(input: {
    id: string
    content?: string
    status?: ConversationEntry["status"]
    artifactIds?: string[]
    memoryIds?: string[]
  }) {
    await this.database.transaction((connection) => {
      const existing = connection.prepare("SELECT workflow_run_id FROM conversation_entries WHERE id = ?")
        .get(input.id) as { workflow_run_id: string } | undefined
      connection.prepare(`
        UPDATE conversation_entries SET
          content = COALESCE(?, content),
          status = COALESCE(?, status),
          artifact_ids_json = COALESCE(?, artifact_ids_json),
          memory_ids_json = COALESCE(?, memory_ids_json)
        WHERE id = ?
      `).run(
        input.content ?? null,
        input.status ?? null,
        input.artifactIds ? JSON.stringify(input.artifactIds) : null,
        input.memoryIds ? JSON.stringify(input.memoryIds) : null,
        input.id
      )
      if (existing) {
        this.touchConversationMetadata(connection, existing.workflow_run_id)
      }
    })
    return this.getConversationEntry(input.id)
  }

  async createConversation(input: { id: string; title: string }): Promise<ConversationMetadata> {
    const now = new Date().toISOString()
    const title = normalizeConversationTitle(input.title)
    await this.database.write((connection) => {
      this.ensureConversationIdentity(input.id)
      connection.prepare(`
        INSERT INTO conversations(id, title, state, created_at, updated_at, archived_at)
        VALUES (?, ?, 'active', ?, ?, NULL)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          updated_at = excluded.updated_at
      `).run(input.id, title, now, now)
    })
    return this.requireConversationMetadata(input.id)
  }

  getConversationMetadata(id: string): ConversationMetadata | undefined {
    return this.database.read((connection) => {
      const row = connection.prepare("SELECT * FROM conversations WHERE id = ?").get(id) as ConversationMetadataRow | undefined
      return row ? conversationMetadataFromRow(row) : undefined
    })
  }

  listConversationSummaries(input: { includeArchived?: boolean } = {}): ConversationSummary[] {
    return this.database.read((connection) =>
      (connection.prepare(`
        SELECT
          conversations.id AS conversationId,
          conversations.title AS title,
          conversations.state AS state,
          COALESCE(stats.messageCount, 0) AS messageCount,
          stats.latestMessageAt AS latestMessageAt,
          stats.latestMessage AS latestMessage
        FROM conversations
        LEFT JOIN (
          SELECT
            entry.workflow_run_id AS conversationId,
            COUNT(*) AS messageCount,
            (
              SELECT latest.created_at
              FROM conversation_entries AS latest
              WHERE latest.workflow_run_id = entry.workflow_run_id
              ORDER BY latest.created_at DESC, latest.id DESC
              LIMIT 1
            ) AS latestMessageAt,
            (
              SELECT latest.content
              FROM conversation_entries AS latest
              WHERE latest.workflow_run_id = entry.workflow_run_id
              ORDER BY latest.created_at DESC, latest.id DESC
              LIMIT 1
            ) AS latestMessage
          FROM conversation_entries AS entry
          GROUP BY entry.workflow_run_id
        ) AS stats
          ON stats.conversationId = conversations.id
        WHERE (conversations.id LIKE 'conversation:%' OR conversations.id = :legacyConversationId)
          AND (:includeArchived = 1 OR conversations.state = 'active')
        ORDER BY conversations.updated_at DESC, conversations.id DESC
      `).all({
        legacyConversationId,
        includeArchived: input.includeArchived ? 1 : 0
      }) as ConversationSummaryRow[]).map(conversationSummaryFromRow)
    )
  }

  async renameConversation(id: string, title: string): Promise<ConversationMetadata> {
    await this.database.write((connection) => {
      const updatedAt = new Date().toISOString()
      const result = connection.prepare(`
        UPDATE conversations
        SET title = ?, updated_at = ?
        WHERE id = ?
      `).run(normalizeConversationTitle(title), updatedAt, id)
      if (result.changes === 0) {
        throw new Error(`Conversation ${id} not found.`)
      }
    })
    return this.requireConversationMetadata(id)
  }

  async setConversationState(id: string, state: ConversationState): Promise<ConversationMetadata> {
    await this.database.write((connection) => {
      const updatedAt = new Date().toISOString()
      const archivedAt = state === "archived" ? updatedAt : null
      const result = connection.prepare(`
        UPDATE conversations
        SET state = ?, updated_at = ?, archived_at = ?
        WHERE id = ?
      `).run(state, updatedAt, archivedAt, id)
      if (result.changes === 0) {
        throw new Error(`Conversation ${id} not found.`)
      }
    })
    return this.requireConversationMetadata(id)
  }

  isConversationRunning(id: string): boolean {
    const session = this.getCodexSession(id)
    return session?.status === "running" || session?.turnStatus === "inProgress"
  }

  async deleteConversation(id: string): Promise<void> {
    this.assertDeletableConversationId(id)
    await this.database.transaction((connection) => {
      connection.prepare(`
        DELETE FROM execution_jobs
        WHERE kind = 'conversation_dispatch' AND workflow_run_id = ?
      `).run(id)
      connection.prepare("DELETE FROM codex_sessions WHERE conversation_id = ?").run(id)
      connection.prepare("DELETE FROM conversation_entries WHERE workflow_run_id = ?").run(id)
      connection.prepare("DELETE FROM conversations WHERE id = ?").run(id)
    })
  }

  getCodexSession(conversationId: string) {
    return this.database.read((connection) => {
      const row = connection.prepare(`
        SELECT * FROM codex_sessions WHERE conversation_id = ?
      `).get(conversationId) as {
        conversation_id: string
        bridge_session_id: string
        codex_thread_id: string
        status: string
        turn_status: string
        current_turn_id: string | null
        cursor: number
        created_at: string
        updated_at: string
      } | undefined

      if (!row) return undefined
      return {
        conversationId: row.conversation_id,
        bridgeSessionId: row.bridge_session_id,
        codexThreadId: row.codex_thread_id,
        status: row.status,
        turnStatus: row.turn_status,
        currentTurnId: row.current_turn_id ?? undefined,
        cursor: row.cursor,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      }
    })
  }

  async upsertCodexSession(input: {
    conversationId: string
    bridgeSessionId: string
    codexThreadId: string
    status: string
    turnStatus: string
    currentTurnId?: string
    cursor?: number
  }) {
    const now = new Date().toISOString()
    await this.database.write((connection) => {
      connection.prepare(`
        INSERT INTO codex_sessions(
          conversation_id, bridge_session_id, codex_thread_id, status,
          turn_status, current_turn_id, cursor, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(conversation_id) DO UPDATE SET
          bridge_session_id = excluded.bridge_session_id,
          codex_thread_id = excluded.codex_thread_id,
          status = excluded.status,
          turn_status = excluded.turn_status,
          current_turn_id = excluded.current_turn_id,
          cursor = excluded.cursor,
          updated_at = excluded.updated_at
      `).run(
        input.conversationId,
        input.bridgeSessionId,
        input.codexThreadId,
        input.status,
        input.turnStatus,
        input.currentTurnId ?? null,
        input.cursor ?? 0,
        now,
        now
      )
    })
    return this.getCodexSession(input.conversationId)
  }

  async updateCodexSession(input: {
    conversationId: string
    status?: string
    turnStatus?: string
    currentTurnId?: string
    cursor?: number
  }) {
    await this.database.write((connection) => {
      connection.prepare(`
        UPDATE codex_sessions SET
          status = COALESCE(?, status),
          turn_status = COALESCE(?, turn_status),
          current_turn_id = COALESCE(?, current_turn_id),
          cursor = MAX(cursor, COALESCE(?, cursor)),
          updated_at = ?
        WHERE conversation_id = ?
      `).run(
        input.status ?? null,
        input.turnStatus ?? null,
        input.currentTurnId ?? null,
        input.cursor ?? null,
        new Date().toISOString(),
        input.conversationId
      )
    })
    return this.getCodexSession(input.conversationId)
  }

  async createManagerTask(input: {
    workflowRunId: string
    parentTaskId?: string
    title: string
    instruction: string
    successCriteria: string[]
    assignedAgent?: string
    strategy: string
  }) {
    const now = new Date().toISOString()
    const task = {
      id: crypto.randomUUID(), workflowRunId: input.workflowRunId,
      parentTaskId: input.parentTaskId, title: input.title,
      instruction: input.instruction, successCriteria: input.successCriteria,
      assignedAgent: input.assignedAgent, status: "pending" as const,
      strategy: input.strategy, attemptCount: 0, lastError: undefined,
      createdAt: now, updatedAt: now
    }
    await this.database.transaction((connection) => {
      connection.prepare(`
        INSERT INTO manager_tasks(
          id, workflow_run_id, parent_task_id, title, instruction,
          success_criteria_json, assigned_agent, status, strategy,
          attempt_count, last_error, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
      `).run(
        task.id, task.workflowRunId, task.parentTaskId ?? null, task.title,
        task.instruction, JSON.stringify(task.successCriteria), task.assignedAgent ?? null,
        task.status, task.strategy, task.attemptCount, task.createdAt, task.updatedAt
      )
      this.insertEvent(connection, {
        eventType: "manager_task_created", actor: "codex",
        workflowRunId: input.workflowRunId, taskId: task.id,
        payload: { taskId: task.id, strategy: task.strategy }
      })
    })
    return task
  }

  listManagerTasks(workflowRunId: string) {
    return this.database.read((connection) =>
      (connection.prepare(`SELECT * FROM manager_tasks WHERE workflow_run_id = ? ORDER BY created_at ASC, id ASC`).all(workflowRunId) as Array<{
        id: string; workflow_run_id: string; parent_task_id: string | null; title: string;
        instruction: string; success_criteria_json: string; assigned_agent: string | null;
        status: "pending" | "running" | "completed" | "failed" | "stopped";
        strategy: string; attempt_count: number; last_error: string | null; created_at: string; updated_at: string
      }>).map((row) => ({
        id: row.id, workflowRunId: row.workflow_run_id,
        parentTaskId: row.parent_task_id ?? undefined, title: row.title,
        instruction: row.instruction, successCriteria: parseStringArray(row.success_criteria_json),
        assignedAgent: row.assigned_agent ?? undefined, status: row.status,
        strategy: row.strategy, attemptCount: row.attempt_count,
        lastError: row.last_error ?? undefined, createdAt: row.created_at, updatedAt: row.updated_at
      }))
    )
  }

  async updateManagerTask(input: {
    id: string
    status?: "pending" | "running" | "completed" | "failed" | "stopped"
    assignedAgent?: string
    strategy?: string
    incrementAttempt?: boolean
    lastError?: string
  }) {
    await this.database.write((connection) => {
      connection.prepare(`
        UPDATE manager_tasks SET
          status = COALESCE(?, status),
          assigned_agent = COALESCE(?, assigned_agent),
          strategy = COALESCE(?, strategy),
          attempt_count = attempt_count + ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ?
      `).run(
        input.status ?? null, input.assignedAgent ?? null, input.strategy ?? null,
        input.incrementAttempt ? 1 : 0, input.lastError ?? null,
        new Date().toISOString(), input.id
      )
    })
  }

  async createExecutionJob(input: CreateExecutionJobInput) {
    const now = new Date().toISOString()
    const job = createQueuedExecutionJob(input, now)

    return this.database.transaction((connection) => {
      const existing = connection.prepare(`
        SELECT * FROM execution_jobs WHERE idempotency_key = ?
      `).get(job.idempotencyKey) as ExecutionJobRow | undefined
      if (existing) {
        return { job: executionJobFromRow(existing), inserted: false }
      }

      connection.prepare(`
        INSERT INTO execution_jobs(
          id, kind, workflow_run_id, payload_json, idempotency_key, status,
          attempt_count, available_at, lease_owner, lease_expires_at,
          result_json, last_error, created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL)
      `).run(
        job.id,
        job.kind,
        job.workflowRunId ?? null,
        job.payloadJson,
        job.idempotencyKey,
        job.status,
        job.attemptCount,
        job.availableAt,
        job.createdAt,
        job.updatedAt
      )

      return { job, inserted: true }
    })
  }

  async createConversationDispatch(input: {
    conversationId: string
    entryId: string
    responseEntryId?: string
    targetAgent: AgentKind
    idempotencyKey: string
  }) {
    return this.createExecutionJob({
      kind: "conversation_dispatch",
      workflowRunId: input.conversationId,
      payload: {
        conversationId: input.conversationId,
        entryId: input.entryId,
        responseEntryId: input.responseEntryId ?? null,
        targetAgent: input.targetAgent
      },
      idempotencyKey: input.idempotencyKey
    })
  }

  getExecutionJob(id: string) {
    return this.database.read((connection) => {
      const row = connection.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(id) as ExecutionJobRow | undefined
      return row ? executionJobFromRow(row) : undefined
    })
  }

  getExecutionJobByIdempotencyKey(idempotencyKey: string) {
    return this.database.read((connection) => {
      const row = connection.prepare("SELECT * FROM execution_jobs WHERE idempotency_key = ?").get(idempotencyKey) as ExecutionJobRow | undefined
      return row ? executionJobFromRow(row) : undefined
    })
  }

  async claimNextExecutionJob(input: ClaimNextExecutionJobInput) {
    const now = input.now ?? new Date().toISOString()
    return this.database.transaction((connection) => {
      this.recoverExpiredExecutionJobsOnConnection(connection, { now, kind: input.kind, workflowRunId: input.workflowRunId })
      const row = connection.prepare(`
        SELECT * FROM execution_jobs
        WHERE status = 'queued'
          AND available_at <= ?
          AND (? IS NULL OR kind = ?)
          AND (? IS NULL OR workflow_run_id = ?)
        ORDER BY available_at ASC, created_at ASC, id ASC
        LIMIT 1
      `).get(
        now,
        input.kind ?? null,
        input.kind ?? null,
        input.workflowRunId ?? null,
        input.workflowRunId ?? null
      ) as ExecutionJobRow | undefined

      if (!row) {
        return undefined
      }

      const next = claimQueuedExecutionJob(executionJobFromRow(row), { ...input, now })
      const result = connection.prepare(`
        UPDATE execution_jobs SET
          status = ?,
          attempt_count = ?,
          available_at = ?,
          lease_owner = ?,
          lease_expires_at = ?,
          result_json = ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(
        next.status,
        next.attemptCount,
        next.availableAt,
        next.leaseOwner ?? null,
        next.leaseExpiresAt ?? null,
        next.resultJson ?? null,
        next.lastError ?? null,
        next.updatedAt,
        next.id
      )

      if (result.changes === 0) {
        throw new Error(`Execution job ${next.id} was not claimable.`)
      }

      return next
    })
  }

  async claimNextConversationDispatch(input: {
    conversationId: string
    leaseOwner: string
    leaseDurationMs: number
  }) {
    const now = new Date().toISOString()
    return this.database.transaction((connection) => {
      this.recoverExpiredExecutionJobsOnConnection(connection, {
        now,
        kind: "conversation_dispatch",
        workflowRunId: input.conversationId
      })
      const running = connection.prepare(`
        SELECT 1 AS present FROM execution_jobs
        WHERE kind = 'conversation_dispatch'
          AND workflow_run_id = ?
          AND status = 'running'
        LIMIT 1
      `).get(input.conversationId) as { present: number } | undefined
      if (running) return undefined

      const row = connection.prepare(`
        SELECT * FROM execution_jobs
        WHERE kind = 'conversation_dispatch'
          AND workflow_run_id = ?
          AND status = 'queued'
          AND available_at <= ?
        ORDER BY created_at ASC, rowid ASC, id ASC
        LIMIT 1
      `).get(input.conversationId, now) as ExecutionJobRow | undefined
      if (!row) return undefined

      const next = claimQueuedExecutionJob(executionJobFromRow(row), {
        leaseOwner: input.leaseOwner,
        leaseDurationMs: input.leaseDurationMs,
        now
      })
      const result = connection.prepare(`
        UPDATE execution_jobs SET
          status = ?, attempt_count = ?, available_at = ?, lease_owner = ?,
          lease_expires_at = ?, result_json = ?, last_error = ?, updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(
        next.status,
        next.attemptCount,
        next.availableAt,
        next.leaseOwner ?? null,
        next.leaseExpiresAt ?? null,
        next.resultJson ?? null,
        next.lastError ?? null,
        next.updatedAt,
        next.id
      )
      if (result.changes === 0) throw new Error(`Execution job ${next.id} was not claimable.`)
      return next
    })
  }

  async renewExecutionJobLease(input: {
    id: string
    leaseOwner: string
    leaseDurationMs: number
  }) {
    const now = new Date().toISOString()
    const leaseExpiresAt = new Date(Date.now() + input.leaseDurationMs).toISOString()
    await this.database.write((connection) => {
      const result = connection.prepare(`
        UPDATE execution_jobs
        SET lease_expires_at = ?, updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `).run(leaseExpiresAt, now, input.id, input.leaseOwner)
      if (result.changes === 0) {
        throw new Error(`Execution job ${input.id} is not running under lease ${input.leaseOwner}.`)
      }
    })
    return this.getExecutionJob(input.id)!
  }

  async cancelQueuedConversationDispatches(conversationId: string) {
    const now = new Date().toISOString()
    return this.database.transaction((connection) => {
      const rows = connection.prepare(`
        SELECT * FROM execution_jobs
        WHERE kind = 'conversation_dispatch'
          AND workflow_run_id = ?
          AND status = 'queued'
      `).all(conversationId) as ExecutionJobRow[]
      for (const row of rows) {
        const next = cancelQueuedExecutionJob(executionJobFromRow(row), { id: row.id, now })
        connection.prepare(`
          UPDATE execution_jobs SET
            status = ?, lease_owner = NULL, lease_expires_at = NULL,
            result_json = NULL, completed_at = ?, updated_at = ?
          WHERE id = ? AND status = 'queued'
        `).run(next.status, next.completedAt ?? null, next.updatedAt, next.id)
      }
      return rows.length
    })
  }

  async claimExecutionJob(input: ClaimExecutionJobInput) {
    const now = input.now ?? new Date().toISOString()
    return this.database.transaction((connection) => {
      const row = connection.prepare(`
        SELECT * FROM execution_jobs
        WHERE id = ?
          AND status = 'queued'
          AND available_at <= ?
      `).get(input.id, now) as ExecutionJobRow | undefined

      if (!row) {
        return undefined
      }

      const next = claimQueuedExecutionJob(executionJobFromRow(row), { ...input, now })
      const result = connection.prepare(`
        UPDATE execution_jobs SET
          status = ?,
          attempt_count = ?,
          available_at = ?,
          lease_owner = ?,
          lease_expires_at = ?,
          result_json = ?,
          last_error = ?,
          updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(
        next.status,
        next.attemptCount,
        next.availableAt,
        next.leaseOwner ?? null,
        next.leaseExpiresAt ?? null,
        next.resultJson ?? null,
        next.lastError ?? null,
        next.updatedAt,
        next.id
      )

      if (result.changes === 0) {
        throw new Error(`Execution job ${next.id} was not claimable.`)
      }

      return next
    })
  }

  async completeExecutionJob(input: CompleteExecutionJobInput) {
    const now = input.now ?? new Date().toISOString()
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(input.id) as ExecutionJobRow | undefined
      if (!row) {
        throw new Error(`Execution job ${input.id} not found.`)
      }
      const next = completeRunningExecutionJob(executionJobFromRow(row), {
        id: input.id,
        leaseOwner: input.leaseOwner,
        result: input.result,
        now
      })
      if (next.resultJson === undefined) {
        throw new Error("Execution job result must be JSON-serializable.")
      }
      const result = connection.prepare(`
        UPDATE execution_jobs SET
          status = ?,
          result_json = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          last_error = NULL,
          completed_at = ?,
          updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `).run(
        next.status,
        next.resultJson,
        next.completedAt ?? null,
        next.updatedAt,
        next.id,
        input.leaseOwner
      )
      if (result.changes === 0) {
        throw new Error(`Execution job ${input.id} is not running under lease ${input.leaseOwner}.`)
      }
      return next
    })
  }

  async failExecutionJob(input: FailExecutionJobInput) {
    const now = input.now ?? new Date().toISOString()
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(input.id) as ExecutionJobRow | undefined
      if (!row) {
        throw new Error(`Execution job ${input.id} not found.`)
      }
      const next = failRunningExecutionJob(executionJobFromRow(row), {
        id: input.id,
        leaseOwner: input.leaseOwner,
        error: input.error,
        now
      })
      const result = connection.prepare(`
        UPDATE execution_jobs SET
          status = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          result_json = NULL,
          last_error = ?,
          completed_at = NULL,
          updated_at = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ?
      `).run(
        next.status,
        next.lastError ?? null,
        next.updatedAt,
        next.id,
        input.leaseOwner
      )
      if (result.changes === 0) {
        throw new Error(`Execution job ${input.id} is not running under lease ${input.leaseOwner}.`)
      }
      return next
    })
  }

  async requeueExecutionJob(input: RequeueExecutionJobInput) {
    const now = input.now ?? new Date().toISOString()
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(input.id) as ExecutionJobRow | undefined
      if (!row) {
        throw new Error(`Execution job ${input.id} not found.`)
      }
      const next = requeueFailedExecutionJob(executionJobFromRow(row), {
        id: input.id,
        now,
        availableAt: input.availableAt
      })
      const result = connection.prepare(`
        UPDATE execution_jobs SET
          status = ?,
          available_at = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          result_json = NULL,
          last_error = NULL,
          completed_at = NULL,
          updated_at = ?
        WHERE id = ? AND status = 'failed'
      `).run(
        next.status,
        next.availableAt,
        next.updatedAt,
        next.id
      )
      if (result.changes === 0) {
        throw new Error(`Execution job ${input.id} is not failed.`)
      }
      return next
    })
  }

  async cancelExecutionJob(input: CancelExecutionJobInput) {
    const now = input.now ?? new Date().toISOString()
    return this.database.transaction((connection) => {
      const row = connection.prepare("SELECT * FROM execution_jobs WHERE id = ?").get(input.id) as ExecutionJobRow | undefined
      if (!row) {
        throw new Error(`Execution job ${input.id} not found.`)
      }
      const next = cancelQueuedExecutionJob(executionJobFromRow(row), {
        id: input.id,
        now
      })
      const result = connection.prepare(`
        UPDATE execution_jobs SET
          status = ?,
          lease_owner = NULL,
          lease_expires_at = NULL,
          result_json = NULL,
          last_error = NULL,
          completed_at = ?,
          updated_at = ?
        WHERE id = ? AND status = 'queued'
      `).run(
        next.status,
        next.completedAt ?? null,
        next.updatedAt,
        next.id
      )
      if (result.changes === 0) {
        throw new Error(`Execution job ${input.id} is not queued.`)
      }
      return next
    })
  }

  async recoverExpiredExecutionJobs(input: RecoverExpiredExecutionJobsInput & { kind?: string; workflowRunId?: string } = {}) {
    const now = input.now ?? new Date().toISOString()
    return this.database.write((connection) =>
      this.recoverExpiredExecutionJobsOnConnection(connection, { now, kind: input.kind, workflowRunId: input.workflowRunId })
    )
  }

  private recoverExpiredExecutionJobsOnConnection(
    connection: Database.Database,
    input: { now: string; kind?: string; workflowRunId?: string }
  ) {
    const result = connection.prepare(`
      UPDATE execution_jobs SET
        status = 'queued',
        available_at = ?,
        lease_owner = NULL,
        lease_expires_at = NULL,
        result_json = NULL,
        last_error = NULL,
        completed_at = NULL,
        updated_at = ?
      WHERE status = 'running'
        AND lease_expires_at IS NOT NULL
        AND lease_expires_at <= ?
        AND (? IS NULL OR kind = ?)
        AND (? IS NULL OR workflow_run_id = ?)
    `).run(
      input.now,
      input.now,
      input.now,
      input.kind ?? null,
      input.kind ?? null,
      input.workflowRunId ?? null,
      input.workflowRunId ?? null
    )
    return result.changes
  }

  private requireMemory(id: string) {
    const memory = this.getMemory(id)
    if (!memory) throw new Error(`Memory ${id} not found.`)
    return memory
  }

  private requireConversationMetadata(id: string) {
    const metadata = this.getConversationMetadata(id)
    if (!metadata) throw new Error(`Conversation ${id} not found.`)
    return metadata
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

  private ensureConversationMetadata(
    connection: Database.Database,
    conversationId: string,
    title: string,
    timestamp = new Date().toISOString()
  ) {
    if (!isConversationMetadataIdentity(conversationId)) return
    connection.prepare(`
      INSERT OR IGNORE INTO conversations(id, title, state, created_at, updated_at, archived_at)
      VALUES (?, ?, 'active', ?, ?, NULL)
    `).run(conversationId, title, timestamp, timestamp)
  }

  private touchConversationMetadata(
    connection: Database.Database,
    conversationId: string,
    timestamp = new Date().toISOString()
  ) {
    if (!isConversationMetadataIdentity(conversationId)) return
    connection.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(timestamp, conversationId)
  }

  private moveConversationMetadata(
    connection: Database.Database,
    sourceWorkflowRunId: string,
    targetWorkflowRunId: string
  ) {
    if (!isConversationMetadataIdentity(sourceWorkflowRunId)) return
    const row = connection.prepare("SELECT * FROM conversations WHERE id = ?").get(sourceWorkflowRunId) as ConversationMetadataRow | undefined
    if (!row) return
    if (isConversationMetadataIdentity(targetWorkflowRunId)) {
      connection.prepare(`
        INSERT INTO conversations(id, title, state, created_at, updated_at, archived_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          title = excluded.title,
          state = excluded.state,
          updated_at = excluded.updated_at,
          archived_at = excluded.archived_at
      `).run(targetWorkflowRunId, row.title, row.state, row.created_at, row.updated_at, row.archived_at)
    }
    connection.prepare("DELETE FROM conversations WHERE id = ?").run(sourceWorkflowRunId)
  }

  private ensureConversationIdentity(id: string) {
    if (!id.startsWith("conversation:")) {
      throw new Error("Conversation id must use the conversation:* identity format.")
    }
  }

  private assertDeletableConversationId(id: string) {
    if (id === legacyConversationId) {
      throw new Error("Legacy conversation data cannot be deleted through the unbound manager.")
    }
    if (!id.startsWith("conversation:")) {
      throw new Error("Only conversation:* identities can be deleted through the unbound manager.")
    }
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

function conversationMetadataFromRow(row: ConversationMetadataRow): ConversationMetadata {
  return {
    conversationId: row.id,
    title: row.title,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at ?? undefined
  }
}

function conversationSummaryFromRow(row: ConversationSummaryRow): ConversationSummary {
  return {
    conversationId: row.conversationId,
    title: row.title,
    state: row.state,
    messageCount: Number(row.messageCount),
    latestMessageAt: row.latestMessageAt ?? undefined,
    latestMessage: row.latestMessage ?? undefined
  }
}

function a2aTaskFromRow(row: A2ATaskRow): A2ATaskRecord {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id ?? undefined,
    contextId: row.context_id,
    remoteTaskId: row.remote_task_id ?? undefined,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    status: normalizeA2ATaskStatus(row.status),
    requestMessageId: row.request_message_id,
    idempotencyKey: row.idempotency_key,
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined
  }
}

function a2aMessageFromRow(row: A2AMessageRow): A2AMessageRecord {
  return {
    id: row.id,
    taskId: row.task_id ?? undefined,
    contextId: row.context_id,
    parentMessageId: row.parent_message_id ?? undefined,
    direction: row.direction,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    protocolVersion: row.protocol_version,
    method: row.method,
    transport: row.transport,
    idempotencyKey: row.idempotency_key ?? undefined,
    requestJson: row.request_json,
    responseJson: row.response_json ?? undefined,
    requestSha256: row.request_sha256,
    responseSha256: row.response_sha256 ?? undefined,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
    receivedAt: row.received_at ?? undefined
  }
}

function a2aEventFromRow(row: A2AEventRow): A2AEventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    messageId: row.message_id ?? undefined,
    sequence: Number(row.sequence),
    eventType: row.event_type,
    actor: row.actor,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    createdAt: row.created_at
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

function executionJobFromRow(row: ExecutionJobRow): ExecutionJob {
  return {
    id: row.id,
    kind: row.kind,
    workflowRunId: row.workflow_run_id ?? undefined,
    payloadJson: row.payload_json,
    idempotencyKey: row.idempotency_key,
    status: row.status,
    attemptCount: row.attempt_count,
    availableAt: row.available_at,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    resultJson: row.result_json ?? undefined,
    lastError: row.last_error ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined
  }
}

function parseStringArray(value: string) {
  const parsed = JSON.parse(value) as unknown
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
}

function clampScore(value: number) {
  return Math.min(1, Math.max(0, value))
}

function conversationFromRow(row: ConversationRow): ConversationEntry {
  return {
    id: row.id,
    workflowRunId: row.workflow_run_id,
    taskId: row.task_id ?? undefined,
    role: row.role,
    agentId: row.agent_id ?? undefined,
    recipientAgent: row.recipient_agent ?? undefined,
    content: row.content,
    importance: row.importance,
    status: row.status,
    replyToId: row.reply_to_id ?? undefined,
    artifactIds: parseStringArray(row.artifact_ids_json),
    memoryIds: parseStringArray(row.memory_ids_json),
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at
  }
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}

export function normalizeContent(value: string) {
  return value.trim().replaceAll(/\s+/g, " ").toLowerCase()
}

function normalizeConversationTitle(value: string) {
  const normalized = value.trim().replaceAll(/\s+/g, " ")
  if (!normalized) return "New conversation"
  return normalized.slice(0, 80)
}

function deriveConversationTitle(role: ConversationEntry["role"], content: string) {
  return role === "user" ? normalizeConversationTitle(content) : "New conversation"
}

function isConversationMetadataIdentity(value: string) {
  return value.startsWith("conversation:") || value === legacyConversationId
}

function tokenize(value: string) {
  return normalizeContent(value).split(/[^a-z0-9_]+/).filter((token) => token.length > 2)
}

function toFtsQuery(value: string) {
  return tokenize(value).map((token) => `"${token.replaceAll('"', '""')}"`).join(" OR ")
}
