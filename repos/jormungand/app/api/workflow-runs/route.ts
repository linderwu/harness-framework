import { NextResponse } from "next/server"
import { publishAgentTaskResponseRecord } from "@/lib/agent-response-records"
import { invokeConfiguredAgent } from "@/lib/agent-bridge"
import { getAgentPermissionMode } from "@/lib/agent-permissions"
import { defaultAgentKind, normalizeAgentKind } from "@/lib/agents"
import { createRuntimeSkillResolver } from "@/lib/runtime-skills"
import { advanceWorkflow, createWorkflowRun } from "@/lib/workflow"
import { createProject } from "@/lib/workspace"
import { getSuperpowersCatalog } from "@/lib/superpowers-catalog"
import { listWorkflowRuns, upsertProject, upsertWorkflowRun } from "@/lib/store"
import type {
  AgentKind,
  CodexReasoningIntensity,
  ProjectContextFile
} from "@/lib/types"

const maxContextFileBytes = 2 * 1024 * 1024
const maxContextTotalBytes = 5 * 1024 * 1024

export async function GET() {
  return NextResponse.json(await listWorkflowRuns())
}

export async function POST(request: Request) {
  const permissionMode = getAgentPermissionMode()
  const allowedReasoningIntensities: CodexReasoningIntensity[] = [
    "auto",
    "low",
    "medium",
    "high"
  ]

  const body = (await request.json()) as {
    projectName?: string
    repository?: string
    requirement?: string
    contextFiles?: ProjectContextFile[]
    selectedAgent?: AgentKind
    selectedModelId?: string
    selectedReasoningIntensity?: CodexReasoningIntensity
    skillAssignments?: Record<string, AgentKind>
    stageAssignments?: Array<{ id?: string; stageName?: string; skillId?: string; agent?: AgentKind }>
  }

  if (!body.projectName || !body.requirement) {
    return NextResponse.json(
      { error: "projectName and requirement are required" },
      { status: 400 }
    )
  }

  const repository = body.repository ?? ""

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

  const project = await upsertProject(
    createProject({
      name: body.projectName,
      type: "development",
      goal: body.requirement,
      repository,
      source: "dashboard",
      contextFiles
    })
  )

  const catalog = await getSuperpowersCatalog()
  const customStages = (body.stageAssignments ?? []).flatMap((stage, index) => {
    const skill = catalog.skills.find((candidate) => candidate.id === stage.skillId)
    if (!skill || !stage.stageName?.trim() || !stage.agent) return []
    return [{
      id: stage.id?.trim() || `stage-${index + 1}`,
      name: stage.stageName.trim(),
      skillId: skill.id,
      agent: normalizeAgentKind(stage.agent),
      skillContent: skill.content,
      commitSha: skill.commitSha
    }]
  })

  const run = createWorkflowRun({
    projectId: project.id,
    projectName: body.projectName,
    repository,
    requirement: body.requirement,
    contextFiles,
    selectedAgent: normalizeAgentKind(body.selectedAgent ?? defaultAgentKind),
    selectedModelId: body.selectedModelId?.trim() || undefined,
    selectedReasoningIntensity: allowedReasoningIntensities.includes(
      body.selectedReasoningIntensity as CodexReasoningIntensity
    )
      ? body.selectedReasoningIntensity
      : undefined,
    skillAssignments: body.skillAssignments,
    customStages
  })

  const intakeRun = await advanceWorkflow(run, {
    invokeAgent: invokeConfiguredAgent,
    resolveRuntimeSkillBundles: createRuntimeSkillResolver(),
    publishAgentTaskRecord: publishAgentTaskResponseRecord,
    permissionMode
  })

  await upsertWorkflowRun(intakeRun)
  return NextResponse.json(intakeRun, { status: 201 })
}
