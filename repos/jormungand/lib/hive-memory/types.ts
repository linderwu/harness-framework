export type MemoryScope = "global" | "project" | "agent" | "task"
export type MemoryKind = "semantic" | "procedural" | "episodic" | "policy" | "handoff"
export type MemoryStatus = "candidate" | "active" | "superseded" | "retracted" | "expired"
export type MemorySensitivity = "public" | "internal" | "sensitive" | "secret_reference"

export interface FormalMemory {
  id: string
  scope: MemoryScope
  scopeId?: string
  kind: MemoryKind
  title: string
  content: string
  summary: string
  status: Exclude<MemoryStatus, "candidate">
  confidence: number
  importance: number
  sourceAgent: string
  sourceEventIds: string[]
  evidenceRefs: string[]
  createdAt: string
  lastUsedAt?: string
  expiresAt?: string
  supersedesId?: string
  sensitivity: MemorySensitivity
  version: number
  invalidationConditions: string
}

export interface MemoryCandidate {
  id: string
  observation: string
  proposedScope: MemoryScope
  proposedScopeId?: string
  proposedKind: MemoryKind
  confidence: number
  importance: number
  sourceAgent: string
  sensitivity: MemorySensitivity
  evidenceRefs: string[]
  sourceEventIds: string[]
  invalidationConditions: string
  status: "candidate" | "activated" | "merged" | "rejected" | "conflict"
  decisionReason?: string
  createdAt: string
  decidedAt?: string
}

export type SubmitMemoryCandidate = Omit<
  MemoryCandidate,
  "id" | "status" | "createdAt" | "decidedAt" | "decisionReason"
>

export interface CreateMemoryInput {
  actor: "codex" | "control_plane"
  scope: MemoryScope
  scopeId?: string
  kind: MemoryKind
  title: string
  content: string
  summary: string
  confidence: number
  importance: number
  sourceAgent: string
  sourceEventIds: string[]
  evidenceRefs: string[]
  sensitivity: MemorySensitivity
  invalidationConditions: string
  expiresAt?: string
  supersedesId?: string
}

export interface MemoryTransitionInput {
  memoryId: string
  actor: "codex" | "control_plane"
  status: "superseded" | "retracted" | "expired"
  reason: string
  evidenceRefs: string[]
  supersededById?: string
}

export interface MemorySearchInput {
  query: string
  projectId?: string
  taskId?: string
  agentId?: string
  allowedSensitivity: MemorySensitivity[]
  limit?: number
}

export interface RecordMemoryUseInput {
  memoryId: string
  workflowRunId: string
  taskId?: string
  contextPackId: string
  outcome?: string
}

export interface MemoryConflict {
  id: string
  leftMemoryId: string
  rightMemoryId: string
  status: "open" | "resolved"
  verificationTaskId?: string
  createdAt: string
  resolvedAt?: string
}

export interface HiveEvent {
  id: string
  eventType: string
  actor: string
  workflowRunId?: string
  taskId?: string
  payload: Record<string, unknown>
  idempotencyKey?: string
  createdAt: string
}

export interface AgentIdentity {
  agentId: string
  role: string
  capabilities: string[]
  tools: string[]
  permissions: string[]
  prohibitions: string[]
  collaborationPreferences: string[]
  updatedAt: string
}

export type ConversationRole = "user" | "agent" | "manager" | "system"
export type ConversationImportance = "normal" | "important" | "critical"
export type ConversationStatus = "queued" | "running" | "completed" | "failed"
export type ConversationState = "active" | "archived"

export interface ConversationEntry {
  id: string
  workflowRunId: string
  taskId?: string
  role: ConversationRole
  agentId?: import("../types").AgentKind
  content: string
  importance: ConversationImportance
  status: ConversationStatus
  replyToId?: string
  artifactIds: string[]
  memoryIds: string[]
  idempotencyKey: string
  createdAt: string
}

export interface ConversationMetadata {
  conversationId: string
  title: string
  state: ConversationState
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

export interface ConversationSummary {
  conversationId: string
  title: string
  state: ConversationState
  messageCount: number
  latestMessageAt?: string
  latestMessage?: string
}

export type PromotionOutcome =
  | { status: "activated"; memory: FormalMemory }
  | { status: "merged"; memory: FormalMemory }
  | { status: "conflict"; conflict: MemoryConflict; verificationTaskId: string }
  | { status: "rejected"; candidate: MemoryCandidate; reason: string }
