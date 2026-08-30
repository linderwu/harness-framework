export type {
  A2AEventRecord,
  A2AEventType,
  A2AMessageDirection,
  A2AMessageRecord,
  A2ATaskRecord,
  A2ATaskStatus
} from "../a2a-runtime"
import type {
  A2AEventType,
  A2AMessageDirection,
  A2ATaskStatus
} from "../a2a-runtime"

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
export type ConversationStatus =
  | "queued"
  | "running"
  | "completed"
  | "interrupted"
  | "canceled"
  | "failed"
export type ConversationState = "active" | "archived"

export type CodexMappingState =
  | "active"
  | "offline"
  | "native_deleted"
  | "replacement_pending"
  | "archived"
  | "deleted"

export type CodexSyncSource = "harness" | "codex"

export interface CodexSyncItem {
  id: string
  conversationId: string
  nativeThreadId: string
  nativeTurnId: string
  nativeItemId: string
  source: CodexSyncSource
  kind: string
  conversationEntryId?: string
  contentHash?: string
  createdAt: string
}

export interface RecordCodexSyncItemInput {
  conversationId: string
  nativeThreadId: string
  nativeTurnId: string
  nativeItemId: string
  source: CodexSyncSource
  kind: string
  conversationEntryId?: string
  contentHash?: string
}

export type OpenClawRuntimeSessionState =
  | "pending"
  | "active"
  | "delivery_unknown"

export interface OpenClawRuntimeSession {
  conversationId: string
  agentId: import("../types").AgentKind
  provider: "openclaw"
  sessionNamespace: "harness-direct-v1"
  state: OpenClawRuntimeSessionState
  sessionKeyFingerprint: string
  bootstrapDelivered: boolean
  lastDeliveredEntryId?: string
  createdAt: string
  updatedAt: string
}

export interface UpsertOpenClawRuntimeSessionInput {
  conversationId: string
  agentId: import("../types").AgentKind
  sessionNamespace: "harness-direct-v1"
  state: OpenClawRuntimeSessionState
  sessionKeyFingerprint: string
  bootstrapDelivered: boolean
  lastDeliveredEntryId?: string
}

export interface ConversationEntry {
  id: string
  workflowRunId: string
  taskId?: string
  role: ConversationRole
  agentId?: import("../types").AgentKind
  recipientAgent?: import("../types").AgentKind
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
  selectedModelId?: string
  selectedReasoningIntensity?: import("../types").CodexReasoningIntensity
  createdAt: string
  updatedAt: string
  archivedAt?: string
}

export interface ConversationSummary {
  conversationId: string
  title: string
  state: ConversationState
  selectedModelId?: string
  selectedReasoningIntensity?: import("../types").CodexReasoningIntensity
  messageCount: number
  latestMessageAt?: string
  latestMessage?: string
}

export type PromotionOutcome =
  | { status: "activated"; memory: FormalMemory }
  | { status: "merged"; memory: FormalMemory }
  | { status: "conflict"; conflict: MemoryConflict; verificationTaskId: string }
  | { status: "rejected"; candidate: MemoryCandidate; reason: string }

export interface CreateA2ATaskInput {
  workflowRunId?: string
  contextId: string
  remoteTaskId?: string
  fromAgent: string
  toAgent: string
  status: A2ATaskStatus
  requestMessageId: string
  idempotencyKey: string
  errorCode?: string
  errorMessage?: string
  completedAt?: string
}

export interface InsertA2AMessageInput {
  taskId?: string
  contextId: string
  parentMessageId?: string
  direction: A2AMessageDirection
  fromAgent: string
  toAgent: string
  protocolVersion: string
  method: string
  transport: string
  idempotencyKey?: string
  requestFrame: unknown
  responseFrame?: unknown
  sentAt?: string
  receivedAt?: string
}

export interface AppendA2AEventInput {
  taskId: string
  messageId?: string
  eventType: A2AEventType
  actor: string
  payload: Record<string, unknown>
}

export interface UpdateA2ATaskInput {
  id: string
  remoteTaskId?: string
  status?: A2ATaskStatus
  errorCode?: string
  errorMessage?: string
  completedAt?: string
}

export type ExecutionJobStatus = "queued" | "running" | "completed" | "failed" | "canceled"

export type ExecutionJobJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ExecutionJobJsonValue[]
  | { readonly [key: string]: ExecutionJobJsonValue }

export interface ExecutionJob {
  id: string
  kind: string
  workflowRunId?: string
  payloadJson: string
  idempotencyKey: string
  status: ExecutionJobStatus
  attemptCount: number
  availableAt: string
  leaseOwner?: string
  leaseExpiresAt?: string
  resultJson?: string
  lastError?: string
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface CreateExecutionJobInput {
  kind: string
  workflowRunId?: string
  payload: ExecutionJobJsonValue
  idempotencyKey: string
  availableAt?: string
}

export interface ClaimNextExecutionJobInput {
  leaseOwner: string
  leaseDurationMs: number
  now?: string
  kind?: string
  workflowRunId?: string
}

export interface ClaimExecutionJobInput {
  id: string
  leaseOwner: string
  leaseDurationMs: number
  now?: string
}

export interface CompleteExecutionJobInput {
  id: string
  leaseOwner: string
  result: ExecutionJobJsonValue
  now?: string
}

export interface FailExecutionJobInput {
  id: string
  leaseOwner: string
  error: string
  now?: string
}

export interface RequeueExecutionJobInput {
  id: string
  now?: string
  availableAt?: string
}

export interface CancelExecutionJobInput {
  id: string
  now?: string
}

export interface RecoverExpiredExecutionJobsInput {
  now?: string
}
