import { NextResponse } from "next/server"
import { publishAgentTaskResponseRecord } from "@/lib/agent-response-records"
import { invokeConfiguredAgent } from "@/lib/agent-bridge"
import { defaultAgentKind, normalizeAgentKind } from "@/lib/agents"
import { createRuntimeSkillResolver } from "@/lib/runtime-skills"
import { getProject, upsertWorkflowRun } from "@/lib/store"
import { advanceWorkflow, createWorkflowRun } from "@/lib/workflow"
import type { AgentKind, ApprovalActorType, WorkflowRun } from "@/lib/types"
import { getDefaultHiveServices } from "@/lib/hive-services"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const project = await getProject(id)

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const body = (await request.json()) as {
    selectedAgent?: AgentKind
    skillAssignments?: Record<string, AgentKind>
    designApprovalActor?: ApprovalActorType
    verificationApprovalActor?: ApprovalActorType
  }
  const run = createWorkflowRun({
    projectId: project.id,
    projectName: project.name,
    projectType: project.type,
    repository: project.repository,
    requirement: project.goal,
    contextFiles: project.contextFiles,
    selectedAgent: normalizeAgentKind(body.selectedAgent ?? defaultAgentKind),
    skillAssignments: body.skillAssignments,
    designApprovalActor: body.designApprovalActor ?? "independent_agent",
    verificationApprovalActor: body.verificationApprovalActor ?? "verification_subagent",
    managedConfig: project.managedConfig
  })

  if (project.managedConfig) {
    try {
      const runningRun = await upsertWorkflowRun({
        ...run,
        status: "running",
        updatedAt: new Date().toISOString()
      })
      const { repository, scheduler } = getDefaultHiveServices()
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
        idempotencyKey: `mission-created:${runningRun.id}`
      })
      await scheduler.runNext(runningRun.id)
      return NextResponse.json(runningRun, { status: 201 })
    } catch (error) {
      const failedRun = await upsertWorkflowRun({
        ...run,
        status: "failed",
        eventLogWarning: `Hive control plane unavailable: ${error instanceof Error ? error.message : String(error)}`,
        updatedAt: new Date().toISOString()
      })
      return NextResponse.json(failedRun, { status: 503 })
    }
  }

  if (project.type === "agent_task") {
    const runningRun = await upsertWorkflowRun({
      ...run,
      status: "running",
      updatedAt: new Date().toISOString()
    })

    void advanceAgentTaskRun(runningRun)

    return NextResponse.json(runningRun, { status: 201 })
  }

  const intakeRun = await advanceWorkflow(run, {
    invokeAgent: invokeConfiguredAgent,
    resolveRuntimeSkillBundles: createRuntimeSkillResolver(),
    publishAgentTaskRecord: publishAgentTaskResponseRecord
  })

  await upsertWorkflowRun(intakeRun)
  return NextResponse.json(intakeRun, { status: 201 })
}

async function advanceAgentTaskRun(run: WorkflowRun) {
  try {
    const advancedRun = await advanceWorkflow(run, {
      invokeAgent: invokeConfiguredAgent,
      resolveRuntimeSkillBundles: createRuntimeSkillResolver(),
      publishAgentTaskRecord: publishAgentTaskResponseRecord
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
