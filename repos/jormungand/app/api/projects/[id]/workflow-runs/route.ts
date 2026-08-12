import { NextResponse } from "next/server"
import { invokeConfiguredAgent } from "@/lib/agent-bridge"
import { defaultAgentKind, normalizeAgentKind } from "@/lib/agents"
import { getProject, upsertWorkflowRun } from "@/lib/store"
import { advanceWorkflow, createWorkflowRun } from "@/lib/workflow"
import type { AgentKind, ApprovalActorType } from "@/lib/types"

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
    verificationApprovalActor: body.verificationApprovalActor ?? "verification_subagent"
  })
  const intakeRun = await advanceWorkflow(run, {
    invokeAgent: invokeConfiguredAgent
  })

  await upsertWorkflowRun(intakeRun)
  return NextResponse.json(intakeRun, { status: 201 })
}
