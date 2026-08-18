import { NextResponse } from "next/server"
import { publishAgentTaskResponseRecord } from "@/lib/agent-response-records"
import { invokeConfiguredAgent } from "@/lib/agent-bridge"
import { getAgentPermissionMode, type AgentPermissionMode } from "@/lib/agent-permissions"
import { defaultAgentKind, normalizeAgentKind } from "@/lib/agents"
import { createRuntimeSkillResolver } from "@/lib/runtime-skills"
import { getProject, upsertWorkflowRun } from "@/lib/store"
import { advanceWorkflow, createWorkflowRun } from "@/lib/workflow"
import type {
  AgentKind,
  ApprovalActorType,
  CodexReasoningIntensity,
  WorkflowRun
} from "@/lib/types"
import { getDefaultHiveServices } from "@/lib/hive-services"
import { getSuperpowersCatalog } from "@/lib/superpowers-catalog"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const permissionMode = getAgentPermissionMode()
  const allowedReasoningIntensities: CodexReasoningIntensity[] = [
    "auto",
    "low",
    "medium",
    "high"
  ]

  const { id } = await context.params
  let project = await getProject(id)

  if (!project) {
    return NextResponse.json({ error: "Project not found" }, { status: 404 })
  }

  const body = (await request.json()) as {
    selectedAgent?: AgentKind
    selectedModelId?: string
    selectedReasoningIntensity?: CodexReasoningIntensity
    skillAssignments?: Record<string, AgentKind>
    stageAssignments?: Array<{ id?: string; stageName?: string; skillId?: string; agent?: AgentKind }>
    designApprovalActor?: ApprovalActorType
    verificationApprovalActor?: ApprovalActorType
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
      const message = error instanceof Error ? error.message : String(error)
      const failedRun = await upsertWorkflowRun({
        ...run,
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
    const runningRun = await upsertWorkflowRun({
      ...run,
      status: "running",
      updatedAt: new Date().toISOString()
    })

  void advanceAgentTaskRun(runningRun, permissionMode)

    return NextResponse.json(runningRun, { status: 201 })
  }

  const intakeRun = await advanceWorkflow(run, {
    invokeAgent: invokeConfiguredAgent,
    resolveRuntimeSkillBundles: createRuntimeSkillResolver(),
    publishAgentTaskRecord: publishAgentTaskResponseRecord,
    permissionMode
  })

  await upsertWorkflowRun(intakeRun)
  return NextResponse.json(intakeRun, { status: 201 })
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
