import { NextResponse } from "next/server"
import { createWorkflowRun } from "@/lib/workflow"
import { listWorkflowRuns, upsertWorkflowRun } from "@/lib/store"
import type { AgentKind, ApprovalActorType } from "@/lib/types"

export async function GET() {
  return NextResponse.json(await listWorkflowRuns())
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    projectName?: string
    repository?: string
    requirement?: string
    selectedAgent?: AgentKind
    skillAssignments?: Record<string, AgentKind>
    designApprovalActor?: ApprovalActorType
    verificationApprovalActor?: ApprovalActorType
  }

  if (!body.projectName || !body.requirement) {
    return NextResponse.json(
      { error: "projectName and requirement are required" },
      { status: 400 }
    )
  }

  const run = createWorkflowRun({
    projectName: body.projectName,
    repository: body.repository ?? "",
    requirement: body.requirement,
    selectedAgent: body.selectedAgent ?? "codex",
    skillAssignments: body.skillAssignments,
    designApprovalActor: body.designApprovalActor ?? "independent_agent",
    verificationApprovalActor:
      body.verificationApprovalActor ?? "verification_subagent"
  })

  await upsertWorkflowRun(run)
  return NextResponse.json(run, { status: 201 })
}
