import { NextResponse } from "next/server"
import { runNextExecutionJob } from "@/lib/execution-job-runner"
import { getDefaultHiveServices } from "@/lib/hive-services"
import { getWorkflowRun } from "@/lib/store"
import type { WorkflowRun } from "@/lib/types"

type DefaultHiveServices = ReturnType<typeof getDefaultHiveServices>

type WorkflowRunManagerRouteDependencies = {
  getWorkflowRun?: (id: string) => Promise<WorkflowRun | undefined>
  repository?: DefaultHiveServices["repository"]
  scheduler?: Pick<DefaultHiveServices["scheduler"], "enqueue" | "runNext">
  scheduleExecutionJobDrain?: (jobId: string) => Promise<void> | void
}

export function createWorkflowRunManagerMessageRouteHandlers(
  dependencies: WorkflowRunManagerRouteDependencies = {}
) {
  return {
    POST: (request: Request, context: { params: Promise<{ id: string }> }) =>
      postManagerMessage(request, context, dependencies)
  }
}

export const { POST } = createWorkflowRunManagerMessageRouteHandlers()

async function postManagerMessage(
  request: Request,
  context: { params: Promise<{ id: string }> },
  dependencies: WorkflowRunManagerRouteDependencies
) {
  const { id } = await context.params
  const run = await (dependencies.getWorkflowRun ?? getWorkflowRun)(id)
  if (!run) return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
  if (!run.managed) return NextResponse.json({ error: "Workflow run is not manager-controlled" }, { status: 409 })
  const body = (await request.json()) as { content?: string; idempotencyKey?: string }
  if (!body.content?.trim() || !body.idempotencyKey?.trim()) {
    return NextResponse.json({ error: "content and idempotencyKey are required" }, { status: 400 })
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
  const executionJobIdempotencyKey = `workflow-run-manager-message:${id}:${idempotencyKey}`
  const existingJob = repository.getExecutionJobByIdempotencyKey(executionJobIdempotencyKey)
  if (existingJob) {
    return NextResponse.json({ status: "queued", jobId: existingJob.id }, { status: 202 })
  }

  const { job } = await repository.createExecutionJob({
    kind: "manager_message",
    workflowRunId: id,
    payload: { eventType: "manager_operator_message" },
    idempotencyKey: executionJobIdempotencyKey
  })
  await repository.appendEvent({
    eventType: "manager_operator_message", actor: "human", workflowRunId: id,
    payload: { content: body.content.trim() }, idempotencyKey
  })
  await scheduler.enqueue({ workflowRunId: id, reason: "operator_message", idempotencyKey: `wake:${idempotencyKey}` })
  const scheduleExecutionJobDrain = dependencies.scheduleExecutionJobDrain ??
    createDefaultExecutionJobDrain({ repository, scheduler })
  await scheduleExecutionJobDrain(job.id)
  return NextResponse.json({ status: "queued", jobId: job.id }, { status: 202 })
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
        manager_message: async (job) => {
          if (!job.workflowRunId) throw new Error("manager_message job is missing workflowRunId.")
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
