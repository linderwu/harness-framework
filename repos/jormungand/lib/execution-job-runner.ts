import type { ExecutionJob, ExecutionJobJsonValue } from "./execution-jobs"
import type { HiveMemoryRepository } from "./hive-memory/repository"

export type ExecutionJobRunnerRepository = Pick<
  HiveMemoryRepository,
  "getExecutionJob" | "claimNextExecutionJob" | "completeExecutionJob" | "failExecutionJob"
>

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

  const claimed = await input.repository.claimNextExecutionJob({
    leaseOwner: input.leaseOwner,
    leaseDurationMs: input.leaseDurationMs,
    kind: target.kind,
    workflowRunId: target.workflowRunId
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
