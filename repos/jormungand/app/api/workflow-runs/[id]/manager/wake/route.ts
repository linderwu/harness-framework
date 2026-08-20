import { NextResponse } from "next/server"
import { getExecutionJobRouteResponse, runNextExecutionJob } from "@/lib/execution-job-runner"
import { getDefaultHiveServices } from "@/lib/hive-services"
import type { ExecutionJob } from "@/lib/hive-memory/types"
import type { ManagerWakeReason } from "@/lib/manager-scheduler"
import { getWorkflowRun } from "@/lib/store"
import type { WorkflowRun } from "@/lib/types"

const wakeReasons: ManagerWakeReason[] = [
  "mission_created", "mission_amended", "worker_completed", "worker_failed",
  "worker_timed_out", "worker_unreachable", "review_blocked", "memory_candidate",
  "memory_conflict", "approval_decided", "health_check", "operator_message",
  "operator_resume"
]

type DefaultHiveServices = ReturnType<typeof getDefaultHiveServices>

type WorkflowRunManagerRouteDependencies = {
  getWorkflowRun?: (id: string) => Promise<WorkflowRun | undefined>
  repository?: DefaultHiveServices["repository"]
  scheduler?: Pick<DefaultHiveServices["scheduler"], "enqueue" | "runNext">
  scheduleExecutionJobDrain?: (jobId: string) => Promise<void> | void
}

export function createWorkflowRunManagerWakeRouteHandlers(
  dependencies: WorkflowRunManagerRouteDependencies = {}
) {
  return {
    POST: (request: Request, context: { params: Promise<{ id: string }> }) =>
      postManagerWake(request, context, dependencies)
  }
}

export const { POST } = createWorkflowRunManagerWakeRouteHandlers()

async function postManagerWake(
  request: Request,
  context: { params: Promise<{ id: string }> },
  dependencies: WorkflowRunManagerRouteDependencies
) {
  const { id } = await context.params
  const run = await (dependencies.getWorkflowRun ?? getWorkflowRun)(id)
  if (!run) return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
  if (!run.managed) return NextResponse.json({ error: "Workflow run is not manager-controlled" }, { status: 409 })
  const body = (await request.json()) as { reason?: ManagerWakeReason; idempotencyKey?: string }
  if (!body.reason || !wakeReasons.includes(body.reason) || !body.idempotencyKey?.trim()) {
    return NextResponse.json({ error: "valid reason and idempotencyKey are required" }, { status: 400 })
  }
  const defaultServices = dependencies.repository ? undefined : getDefaultHiveServices()
  const repository = dependencies.repository ?? defaultServices!.repository
  const scheduler = dependencies.scheduler ?? defaultServices?.scheduler ?? {
    enqueue: (input: { workflowRunId: string; reason: string; idempotencyKey: string }) =>
      repository.enqueueManagerWake(input),
    runNext: async () => {
      throw new Error("Manager scheduler is unavailable.")
    }
  }
  const idempotencyKey = body.idempotencyKey.trim()
  const executionJobIdempotencyKey = `workflow-run-manager-wake:${id}:${idempotencyKey}`
  const scheduleExecutionJobDrain = dependencies.scheduleExecutionJobDrain ??
    createDefaultExecutionJobDrain({ repository, scheduler })
  const existingJob = repository.getExecutionJobByIdempotencyKey(executionJobIdempotencyKey)
  if (existingJob) {
    return respondWithExecutionJob(existingJob, scheduleExecutionJobDrain)
  }

  let createdJob: ExecutionJob | undefined
  try {
    const created = await repository.createExecutionJob({
      kind: "manager_wake",
      workflowRunId: id,
      payload: { reason: body.reason },
      idempotencyKey: executionJobIdempotencyKey
    })
    if (!created.inserted) {
      return respondWithExecutionJob(created.job, scheduleExecutionJobDrain)
    }
    createdJob = created.job
    await scheduler.enqueue({ workflowRunId: id, reason: body.reason, idempotencyKey })
    return respondWithExecutionJob(createdJob, scheduleExecutionJobDrain, true)
  } catch (error) {
    if (createdJob) {
      await repository.cancelExecutionJob({ id: createdJob.id }).catch(() => undefined)
    }
    throw error
  }
}

async function respondWithExecutionJob(
  job: ExecutionJob,
  scheduleExecutionJobDrain: (jobId: string) => Promise<void> | void,
  allowDrain = false
) {
  const response = getExecutionJobRouteResponse(job)
  if (response.shouldScheduleDrain && (allowDrain || response.isLeaseExpired)) {
    await scheduleExecutionJobDrain(job.id)
  }
  return NextResponse.json(response.body, { status: response.httpStatus })
}

function createDefaultExecutionJobDrain(input: {
  repository: DefaultHiveServices["repository"]
  scheduler: Pick<DefaultHiveServices["scheduler"], "runNext">
}) {
  return (jobId: string) => {
    void runNextExecutionJob({
      repository: input.repository,
      jobId,
      leaseOwner: `route:${process.pid}`,
      leaseDurationMs: 5 * 60 * 1000,
      handlers: {
        manager_wake: async (job) => {
          if (!job.workflowRunId) throw new Error("manager_wake job is missing workflowRunId.")
          const result = await input.scheduler.runNext(job.workflowRunId)
          return { status: result.status }
        }
      }
    }).catch((error) => {
      console.error("Execution job drain failed", {
        jobId,
        error: error instanceof Error ? error.message : String(error)
      })
    })
  }
}
