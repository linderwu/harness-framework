import type {
  CancelExecutionJobInput,
  ClaimNextExecutionJobInput,
  CompleteExecutionJobInput,
  CreateExecutionJobInput,
  ExecutionJob,
  ExecutionJobJsonValue,
  ExecutionJobStatus,
  FailExecutionJobInput,
  RecoverExpiredExecutionJobsInput,
  RequeueExecutionJobInput
} from "./hive-memory/types"

export type {
  CancelExecutionJobInput,
  ClaimExecutionJobInput,
  ClaimNextExecutionJobInput,
  CompleteExecutionJobInput,
  CreateExecutionJobInput,
  ExecutionJob,
  ExecutionJobJsonValue,
  ExecutionJobStatus,
  FailExecutionJobInput,
  RecoverExpiredExecutionJobsInput,
  RequeueExecutionJobInput
} from "./hive-memory/types"

const executionJobErrorCap = 500

export function createQueuedExecutionJob(input: CreateExecutionJobInput, now = new Date().toISOString()): ExecutionJob {
  return {
    id: crypto.randomUUID(),
    kind: input.kind,
    workflowRunId: input.workflowRunId,
    payloadJson: serializeExecutionJobJson(input.payload, "payload"),
    idempotencyKey: input.idempotencyKey,
    status: "queued",
    attemptCount: 0,
    availableAt: input.availableAt ?? now,
    createdAt: now,
    updatedAt: now
  }
}

export function claimQueuedExecutionJob(job: ExecutionJob, input: ClaimNextExecutionJobInput): ExecutionJob {
  assertQueued(job)
  if (compareIsoInstant(job.availableAt, input.now ?? new Date().toISOString()) > 0) {
    throw new Error("Execution job is not yet available.")
  }
  const now = input.now ?? new Date().toISOString()
  return {
    ...job,
    status: "running",
    attemptCount: job.attemptCount + 1,
    leaseOwner: input.leaseOwner,
    leaseExpiresAt: leaseExpiry(now, input.leaseDurationMs),
    resultJson: undefined,
    lastError: undefined,
    completedAt: undefined,
    updatedAt: now
  }
}

export function completeRunningExecutionJob(job: ExecutionJob, input: CompleteExecutionJobInput): ExecutionJob {
  const now = input.now ?? new Date().toISOString()
  assertRunning(job)
  assertLeaseOwnership(job, input.leaseOwner)
  assertLeaseNotExpired(job, now)
  return {
    ...job,
    status: "completed",
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    resultJson: serializeExecutionJobJson(input.result, "result"),
    lastError: undefined,
    completedAt: now,
    updatedAt: now
  }
}

export function failRunningExecutionJob(job: ExecutionJob, input: FailExecutionJobInput): ExecutionJob {
  const now = input.now ?? new Date().toISOString()
  assertRunning(job)
  assertLeaseOwnership(job, input.leaseOwner)
  assertLeaseNotExpired(job, now)
  return {
    ...job,
    status: "failed",
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    resultJson: undefined,
    lastError: truncateExecutionJobError(input.error),
    completedAt: undefined,
    updatedAt: now
  }
}

export function requeueFailedExecutionJob(job: ExecutionJob, input: RequeueExecutionJobInput): ExecutionJob {
  const now = input.now ?? new Date().toISOString()
  assertStatus(job, "failed")
  return {
    ...job,
    status: "queued",
    availableAt: input.availableAt ?? now,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    resultJson: undefined,
    lastError: undefined,
    completedAt: undefined,
    updatedAt: now
  }
}

export function cancelQueuedExecutionJob(job: ExecutionJob, input: CancelExecutionJobInput): ExecutionJob {
  const now = input.now ?? new Date().toISOString()
  assertStatus(job, "queued")
  return {
    ...job,
    status: "canceled",
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    resultJson: undefined,
    lastError: undefined,
    completedAt: now,
    updatedAt: now
  }
}

export function recoverExpiredRunningExecutionJob(job: ExecutionJob, input: RecoverExpiredExecutionJobsInput): ExecutionJob | null {
  const now = input.now ?? new Date().toISOString()
  if (!isExecutionJobLeaseExpired(job, now)) {
    return null
  }
  return {
    ...job,
    status: "queued",
    availableAt: now,
    leaseOwner: undefined,
    leaseExpiresAt: undefined,
    resultJson: undefined,
    lastError: undefined,
    completedAt: undefined,
    updatedAt: now
  }
}

export function isExecutionJobLeaseExpired(job: ExecutionJob, now: string) {
  return job.status === "running" && job.leaseExpiresAt !== undefined && compareIsoInstant(job.leaseExpiresAt, now) <= 0
}

export function truncateExecutionJobError(value: string) {
  return value.length <= executionJobErrorCap ? value : value.slice(0, executionJobErrorCap)
}

function serializeExecutionJobJson(value: ExecutionJobJsonValue, fieldName: "payload" | "result") {
  if (!isExecutionJobJsonValue(value)) {
    throw new Error(`Execution job ${fieldName} must be JSON-serializable.`)
  }

  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) {
      throw new Error("JSON.stringify returned undefined")
    }
    return serialized
  } catch {
    throw new Error(`Execution job ${fieldName} must be JSON-serializable.`)
  }
}

function isExecutionJobJsonValue(value: unknown, seen = new WeakSet<object>()): value is ExecutionJobJsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return true
  }
  if (typeof value === "number") {
    return Number.isFinite(value)
  }
  if (typeof value !== "object") {
    return false
  }

  if (seen.has(value)) {
    return false
  }
  seen.add(value)

  const valid = Array.isArray(value)
    ? value.every((item) => isExecutionJobJsonValue(item, seen))
    : (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
      Object.keys(value).every((key) => isExecutionJobJsonValue((value as { readonly [key: string]: unknown })[key], seen))
  seen.delete(value)
  return valid
}

function assertQueued(job: ExecutionJob) {
  assertStatus(job, "queued")
}

function assertRunning(job: ExecutionJob) {
  assertStatus(job, "running")
}

function assertStatus(job: ExecutionJob, expected: ExecutionJobStatus) {
  if (job.status !== expected) {
    throw new Error(`Execution job ${job.id} must be ${expected} to transition from ${job.status}.`)
  }
}

function assertLeaseOwnership(job: ExecutionJob, leaseOwner: string) {
  if (job.leaseOwner !== leaseOwner) {
    throw new Error(`Execution job ${job.id} is leased to another owner.`)
  }
}

function assertLeaseNotExpired(job: ExecutionJob, now: string) {
  if (job.leaseExpiresAt && compareIsoInstant(job.leaseExpiresAt, now) <= 0) {
    throw new Error(`Execution job ${job.id} lease expired.`)
  }
}

function leaseExpiry(now: string, leaseDurationMs: number) {
  if (!Number.isFinite(leaseDurationMs) || leaseDurationMs <= 0) {
    throw new Error("Execution job lease duration must be positive.")
  }
  return new Date(new Date(now).getTime() + leaseDurationMs).toISOString()
}

function compareIsoInstant(left: string, right: string) {
  if (left === right) return 0
  return left < right ? -1 : 1
}
