import type { ExecutionJob, ExecutionJobJsonValue } from "./execution-jobs"
import type { HiveMemoryRepository } from "./hive-memory/repository"

export type ExecutionJobRunnerRepository = Pick<
  HiveMemoryRepository,
  "getExecutionJob" | "claimExecutionJob" | "completeExecutionJob" | "failExecutionJob"
>

export type ExecutionJobRouteResponse = {
  body: {
    status: "queued" | "completed" | "failed" | "canceled"
    jobId: string
    error?: string
  }
  httpStatus: 202 | 200 | 500 | 409
  shouldScheduleDrain: boolean
}

export function getExecutionJobRouteResponse(job: ExecutionJob): ExecutionJobRouteResponse {
  if (job.status === "queued") {
    return { body: { status: "queued", jobId: job.id }, httpStatus: 202, shouldScheduleDrain: true }
  }
  if (job.status === "running") {
    return { body: { status: "queued", jobId: job.id }, httpStatus: 202, shouldScheduleDrain: false }
  }
  if (job.status === "completed") {
    return { body: { status: "completed", jobId: job.id }, httpStatus: 200, shouldScheduleDrain: false }
  }
  if (job.status === "failed") {
    return {
      body: { status: "failed", jobId: job.id, error: job.lastError ?? "Execution job failed." },
      httpStatus: 500,
      shouldScheduleDrain: false
    }
  }
  return { body: { status: "canceled", jobId: job.id }, httpStatus: 409, shouldScheduleDrain: false }
}

export async function runNextExecutionJob(input: {
  repository: ExecutionJobRunnerRepository
  jobId: string
  leaseOwner: string
  leaseDurationMs: number
  handlers: Record<string, (job: ExecutionJob) => Promise<ExecutionJobJsonValue>>
}) {
  const target = input.repository.getExecutionJob(input.jobId)
  if (!target || target.status !== "queued") {
    return target
  }

  const claimed = await input.repository.claimExecutionJob({
    id: target.id,
    leaseOwner: input.leaseOwner,
    leaseDurationMs: input.leaseDurationMs,
  })
  if (!claimed) return undefined

  const handler = input.handlers[claimed.kind]
  if (!handler) {
    await input.repository.failExecutionJob({
      id: claimed.id,
      leaseOwner: input.leaseOwner,
      error: `No execution job handler registered for ${claimed.kind}.`
    })
    return input.repository.getExecutionJob(claimed.id)
  }

  try {
    const result = await handler(claimed)
    return await input.repository.completeExecutionJob({
      id: claimed.id,
      leaseOwner: input.leaseOwner,
      result
    })
  } catch (error) {
    await input.repository.failExecutionJob({
      id: claimed.id,
      leaseOwner: input.leaseOwner,
      error: error instanceof Error ? error.message : String(error)
    })
    return input.repository.getExecutionJob(claimed.id)
  }
}
