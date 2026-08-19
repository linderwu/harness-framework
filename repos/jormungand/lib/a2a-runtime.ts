import { createHash } from "node:crypto"

export type A2AMessageDirection = "inbound" | "outbound"

export type A2ATaskStatus =
  | "submitted"
  | "working"
  | "input-required"
  | "completed"
  | "failed"
  | "canceled"
  | "unknown"

export type A2AEventType =
  | "message_queued"
  | "message_sent"
  | "message_accepted"
  | "task_working"
  | "task_input_required"
  | "task_artifact_updated"
  | "task_completed"
  | "task_failed"
  | "task_canceled"
  | "task_timeout"
  | "task_retried"

export interface A2AMessageRecord {
  id: string
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
  requestJson: string
  responseJson?: string
  requestSha256: string
  responseSha256?: string
  createdAt: string
  sentAt?: string
  receivedAt?: string
}

export interface A2ATaskRecord {
  id: string
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
  createdAt: string
  updatedAt: string
  completedAt?: string
}

export interface A2AEventRecord {
  id: string
  taskId: string
  messageId?: string
  sequence: number
  eventType: A2AEventType
  actor: string
  payload: Record<string, unknown>
  createdAt: string
}

const redactedKeyPattern =
  /authorization|token|password|secret|cookie|site_auth/i

const taskStatusMap = new Map<string, A2ATaskStatus>([
  ["submitted", "submitted"],
  ["working", "working"],
  ["input-required", "input-required"],
  ["input_required", "input-required"],
  ["completed", "completed"],
  ["failed", "failed"],
  ["canceled", "canceled"],
  ["cancelled", "canceled"],
  ["unknown", "unknown"]
])

export function redactA2AFrame<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactA2AFrame(item)) as T
  }
  if (!value || typeof value !== "object") {
    return value
  }

  const entries = Object.entries(value as Record<string, unknown>).map(([key, child]) => [
    key,
    redactedKeyPattern.test(key) ? "[REDACTED]" : redactA2AFrame(child)
  ])

  return Object.fromEntries(entries) as T
}

export function canonicalizeJson(value: unknown) {
  return JSON.stringify(sortJsonValue(value))
}

export function sha256Json(value: unknown) {
  return createHash("sha256")
    .update(canonicalizeJson(value), "utf8")
    .digest("hex")
}

export function normalizeA2ATaskStatus(value: string | null | undefined): A2ATaskStatus {
  const normalized = value?.trim().toLowerCase()
  if (!normalized) {
    return "unknown"
  }
  return taskStatusMap.get(normalized) ?? "unknown"
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortJsonValue(item))
  }
  if (!value || typeof value !== "object") {
    return value
  }

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJsonValue(child)])
  )
}
