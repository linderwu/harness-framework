import { NextResponse } from "next/server"
import { createHash } from "node:crypto"
import { publishAgentTaskResponseRecord } from "@/lib/agent-response-records"
import { invokeConfiguredAgent } from "@/lib/agent-bridge"
import { getAgentPermissionMode, type AgentPermissionMode } from "@/lib/agent-permissions"
import { defaultAgentKind, normalizeAgentKind } from "@/lib/agents"
import { getExecutionJobRouteResponse, runNextExecutionJob } from "@/lib/execution-job-runner"
import { createRuntimeSkillResolver } from "@/lib/runtime-skills"
import { getProject, getWorkflowRun, upsertWorkflowRun } from "@/lib/store"
import { advanceWorkflow, createWorkflowRun } from "@/lib/workflow"
import type {
  AgentKind,
  CodexReasoningIntensity,
  Project,
  WorkflowRun
} from "@/lib/types"
import { getDefaultHiveServices } from "@/lib/hive-services"
import { getSuperpowersCatalog } from "@/lib/superpowers-catalog"
import type { ExecutionJob } from "@/lib/hive-memory/types"

type DefaultHiveServices = ReturnType<typeof getDefaultHiveServices>

type ProjectWorkflowRunsRouteDependencies = {
  getProject?: (id: string) => Promise<Project | undefined>
  repository?: DefaultHiveServices["repository"]
  scheduler?: Pick<DefaultHiveServices["scheduler"], "enqueue" | "runNext">
  upsertWorkflowRun?: typeof upsertWorkflowRun
  scheduleExecutionJobDrain?: (jobId: string) => Promise<void> | void
}

export function createProjectWorkflowRunsRouteHandlers(
  dependencies: ProjectWorkflowRunsRouteDependencies = {}
) {
  return {
    POST: (request: Request, context: { params: Promise<{ id: string }> }) =>
      postProjectWorkflowRun(request, context, dependencies)
  }
}

export const { POST } = createProjectWorkflowRunsRouteHandlers()

async function postProjectWorkflowRun(
  request: Request,
  context: { params: Promise<{ id: string }> },
  dependencies: ProjectWorkflowRunsRouteDependencies
) {
  const permissionMode = getAgentPermissionMode()
  const defaultServices = dependencies.repository ? undefined : getDefaultHiveServices()
  const repository = dependencies.repository ?? defaultServices!.repository
  const persistWorkflowRun = dependencies.upsertWorkflowRun ?? upsertWorkflowRun
  const scheduler = dependencies.scheduler ?? defaultServices?.scheduler ?? {
    enqueue: (input: { workflowRunId: string; reason: string; idempotencyKey: string }) =>
      repository.enqueueManagerWake(input),
    runNext: async () => {
      throw new Error("Manager scheduler is unavailable.")
    }
  }
  const scheduleExecutionJobDrain = dependencies.scheduleExecutionJobDrain ??
    createDefaultExecutionJobDrain({ repository, scheduler, permissionMode })
  const allowedReasoningIntensities: CodexReasoningIntensity[] = [
    "auto",
    "low",
    "medium",
    "high"
  ]

  const { id } = await context.params
  const project = await (dependencies.getProject ?? getProject)(id)

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const body = (await request.json()) as {
    selectedAgent?: AgentKind
    selectedModelId?: string
    selectedReasoningIntensity?: CodexReasoningIntensity
    skillAssignments?: Record<string, AgentKind>
    stageAssignments?: Array<{ id?: string; stageName?: string; skillId?: string; agent?: AgentKind }>
  }

  const catalog = await getSuperpowersCatalog()
  const customStages = (body.stageAssignments ?? []).flatMap((stage, index) => {
    const skill = catalog.skills.find((candidate) => candidate.id === stage.skillId)
    if (!skill || !stage.stageName?.trim() || !stage.agent) return []
    return [{ id: stage.id?.trim() || `stage-${index + 1}`, name: stage.stageName.trim(), skillId: skill.id, agent: normalizeAgentKind(stage.agent), skillContent: skill.content, commitSha: skill.commitSha }]
  })

  const run = createWorkflowRun({
    projectId: project.id,
    projectName: project.name,
    projectType: project.type,
    repository: project.repository,
    requirement: project.goal,
    contextFiles: project.contextFiles,
    selectedAgent: normalizeAgentKind(body.selectedAgent ?? defaultAgentKind),
    selectedModelId: body.selectedModelId?.trim() || undefined,
    selectedReasoningIntensity: allowedReasoningIntensities.includes(
      body.selectedReasoningIntensity as CodexReasoningIntensity
    )
      ? body.selectedReasoningIntensity
      : undefined,
    skillAssignments: body.skillAssignments,
    customStages,
    managedConfig: project.managedConfig
  })

  if (project.managedConfig) {
    const requestIdempotencyKey = request.headers.get("Idempotency-Key")?.trim()
    const managedRun = requestIdempotencyKey
      ? { ...run, id: stableWorkflowRunId(project.id, requestIdempotencyKey) }
      : run
    const executionJobIdempotencyKey = `mission-created:${managedRun.id}`
    const existingJob = repository.getExecutionJobByIdempotencyKey(executionJobIdempotencyKey)
    if (existingJob) {
      return respondWithExecutionJob(existingJob, scheduleExecutionJobDrain)
    }

    let createdJob: ExecutionJob | undefined
    try {
      const created = await repository.createExecutionJob({
        kind: "workflow_run_start",
        workflowRunId: managedRun.id,
        payload: { reason: "mission_created" },
        idempotencyKey: executionJobIdempotencyKey
      })
      if (!created.inserted) {
        return respondWithExecutionJob(created.job, scheduleExecutionJobDrain)
      }
      createdJob = created.job
      const runningRun = await persistWorkflowRun({
        ...managedRun,
        status: "running",
        updatedAt: new Date().toISOString()
      })
      await repository.createManagerTask({
        workflowRunId: runningRun.id,
        title: project.name,
        instruction: project.goal,
        successCriteria: project.managedConfig.successCriteria,
        assignedAgent: "codex",
        strategy: "manager-decomposition"
      })
      await scheduler.enqueue({
        workflowRunId: runningRun.id,
        reason: "mission_created",
        idempotencyKey: executionJobIdempotencyKey
      })
      return respondWithExecutionJob(createdJob, scheduleExecutionJobDrain, true)
    } catch (error) {
      if (createdJob) {
        await repository.cancelExecutionJob({ id: createdJob.id }).catch(() => undefined)
      }
      const message = error instanceof Error ? error.message : String(error)
      const failedRun = await persistWorkflowRun({
        ...managedRun,
        status: "failed",
        eventLogWarning: `Hive control plane unavailable: ${message}`,
        updatedAt: new Date().toISOString()
      })
      console.error("Managed workflow start failed", {
        projectId: project.id,
        workflowRunId: failedRun.id,
        error: message
      })
      return NextResponse.json(
        { error: message, latestRun: failedRun },
        { status: 503 }
      )
    }
  }

  if (project.type === "agent_task") {
    const requestIdempotencyKey = request.headers.get("Idempotency-Key")?.trim()
    const agentTaskRun = requestIdempotencyKey
      ? { ...run, id: stableWorkflowRunId(project.id, requestIdempotencyKey) }
      : run
    const executionJobIdempotencyKey = `agent-task-advance:${agentTaskRun.id}`
    const existingJob = repository.getExecutionJobByIdempotencyKey(executionJobIdempotencyKey)
    if (existingJob) {
      return respondWithExecutionJob(existingJob, scheduleExecutionJobDrain)
    }

    let createdJob: ExecutionJob | undefined
    try {
      const created = await repository.createExecutionJob({
        kind: "agent_task_advance",
        workflowRunId: agentTaskRun.id,
        payload: { version: agentTaskRun.version },
        idempotencyKey: executionJobIdempotencyKey
      })
      if (!created.inserted) {
        return respondWithExecutionJob(created.job, scheduleExecutionJobDrain)
      }
      createdJob = created.job
      await persistWorkflowRun({
        ...agentTaskRun,
        status: "running",
        updatedAt: new Date().toISOString()
      })
      return respondWithExecutionJob(createdJob, scheduleExecutionJobDrain, true)
    } catch (error) {
      if (createdJob) {
        await repository.cancelExecutionJob({ id: createdJob.id }).catch(() => undefined)
      }
      throw error
    }
  }

  const intakeRun = await advanceWorkflow(run, {
    invokeAgent: invokeConfiguredAgent,
    resolveRuntimeSkillBundles: createRuntimeSkillResolver(),
    publishAgentTaskRecord: publishAgentTaskResponseRecord,
    permissionMode
  })

  await persistWorkflowRun(intakeRun)
  return NextResponse.json(intakeRun, { status: 201 })
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

async function advanceAgentTaskRun(
  run: WorkflowRun,
  permissionMode: AgentPermissionMode
) {
  try {
    const advancedRun = await advanceWorkflow(run, {
      invokeAgent: invokeConfiguredAgent,
      resolveRuntimeSkillBundles: createRuntimeSkillResolver(),
      publishAgentTaskRecord: publishAgentTaskResponseRecord,
      permissionMode
    })

  await upsertWorkflowRun(advancedRun, { expectedVersion: run.version })
  } catch (error) {
    await upsertWorkflowRun({
      ...run,
      status: "failed",
      eventLogWarning: error instanceof Error ? error.message : String(error),
      updatedAt: new Date().toISOString()
    }).catch(() => undefined)
  }
}

function createDefaultExecutionJobDrain(input: {
  repository: DefaultHiveServices["repository"]
  scheduler: Pick<DefaultHiveServices["scheduler"], "runNext">
  permissionMode: AgentPermissionMode
}) {
  return (jobId: string) => {
    void runNextExecutionJob({
      repository: input.repository,
      jobId,
      leaseOwner: `route:${process.pid}`,
      leaseDurationMs: 5 * 60 * 1000,
      handlers: {
        workflow_run_start: async (job) => {
          if (!job.workflowRunId) throw new Error("workflow_run_start job is missing workflowRunId.")
          const result = await input.scheduler.runNext(job.workflowRunId)
          return { status: result.status }
        },
        agent_task_advance: async (job) => {
          if (!job.workflowRunId) throw new Error("agent_task_advance job is missing workflowRunId.")
          const run = await getWorkflowRunForAdvance(job.workflowRunId)
          await advanceAgentTaskRun(run, input.permissionMode)
          return { status: "advanced" }
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

async function getWorkflowRunForAdvance(id: string) {
  const run = await getWorkflowRun(id)
  if (!run) throw new Error(`Workflow run ${id} not found.`)
  return run
}

function stableWorkflowRunId(projectId: string, idempotencyKey: string) {
  const digest = createHash("sha256")
    .update(`${projectId}:${idempotencyKey}`)
    .digest("hex")
    .slice(0, 24)
  return `run-${digest}`
}
