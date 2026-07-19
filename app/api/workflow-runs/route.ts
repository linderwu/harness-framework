import { NextResponse } from "next/server"
import { invokeConfiguredAgent } from "@/lib/agent-bridge"
import { defaultAgentKind, normalizeAgentKind } from "@/lib/agents"
import { advanceWorkflow, createWorkflowRun } from "@/lib/workflow"
import { listWorkflowRuns, upsertWorkflowRun } from "@/lib/store"
import type {
  AgentKind,
  ApprovalActorType,
  ProjectContextFile
} from "@/lib/types"

const maxContextFileBytes = 2 * 1024 * 1024
const maxContextTotalBytes = 5 * 1024 * 1024

export async function GET() {
  return NextResponse.json(await listWorkflowRuns())
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    projectName?: string
    repository?: string
    requirement?: string
    contextFiles?: ProjectContextFile[]
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

  const contextFiles = Array.isArray(body.contextFiles) ? body.contextFiles : []
  const totalContextBytes = contextFiles.reduce(
    (total, file) => total + (Number.isFinite(file.size) ? file.size : 0),
    0
  )
  const oversizedFile = contextFiles.find(
    (file) => file.size > maxContextFileBytes
  )

  if (oversizedFile || totalContextBytes > maxContextTotalBytes) {
    return NextResponse.json(
      {
        error:
          "Context files are too large for JSON-backed workflow state. Use smaller text context or a repository reference."
      },
      { status: 413 }
    )
  }

  const run = createWorkflowRun({
    projectName: body.projectName,
    repository: body.repository ?? "",
    requirement: body.requirement,
    contextFiles,
    selectedAgent: normalizeAgentKind(body.selectedAgent ?? defaultAgentKind),
    skillAssignments: body.skillAssignments,
    designApprovalActor: body.designApprovalActor ?? "independent_agent",
    verificationApprovalActor:
      body.verificationApprovalActor ?? "verification_subagent"
  })

  const intakeRun = await advanceWorkflow(run, {
    invokeAgent: invokeConfiguredAgent
  })

  await upsertWorkflowRun(intakeRun)
  return NextResponse.json(intakeRun, { status: 201 })
}
