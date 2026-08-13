import {
  upsertGitHubFile,
  type GitHubFileUpsertInput,
  type GitHubFileUpsertResult
} from "./github-repository"
import type { Artifact, WorkflowRun } from "./types"

export interface AgentTaskRecord {
  path: string
  content: string
}

export interface AgentTaskRecordPublishOptions {
  repository?: string
  upsertFile?: (input: GitHubFileUpsertInput) => Promise<GitHubFileUpsertResult>
}

export type AgentTaskRecordPublishResult =
  | GitHubFileUpsertResult
  | {
      status: "skipped"
      reason: "not_agent_task" | "missing_response_artifact"
    }

export function getAgentTaskResponseArtifact(run: WorkflowRun) {
  if (run.projectType !== "agent_task") {
    return undefined
  }

  return run.artifacts.find(
    (artifact) => artifact.type === "log" && artifact.title === "Agent Response"
  )
}

export function getAgentTaskRecordPath(run: WorkflowRun) {
  const date = new Date(run.updatedAt || run.createdAt)
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")

  return `records/${year}/${month}/${day}/${run.id}.md`
}

export function formatAgentTaskRecordMarkdown(run: WorkflowRun) {
  const artifact = getAgentTaskResponseArtifact(run)

  if (!artifact) {
    return undefined
  }

  const sections = parseMixedResponseArtifact(artifact)

  return [
    "# Agent Task Response",
    "",
    `Project: ${run.projectName}`,
    `Workflow Run: ${run.id}`,
    `Project ID: ${run.projectId}`,
    `Selected Agent: ${run.selectedAgent}`,
    `Source: ${run.source}`,
    run.repository ? `Repository: ${run.repository}` : undefined,
    `Status: ${run.status}`,
    `Created: ${run.createdAt}`,
    `Updated: ${run.updatedAt}`,
    "",
    "## Original Instruction",
    "",
    sections.originalInstruction || run.requirement,
    "",
    "## Raw Agent Response",
    "",
    sections.rawAgentResponse || artifact.body,
    "",
    "## Closeout Status",
    "",
    sections.closeoutStatus || inferCloseoutStatus(run)
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n")
}

export function createAgentTaskRecord(
  run: WorkflowRun
): AgentTaskRecord | undefined {
  const content = formatAgentTaskRecordMarkdown(run)

  if (!content) {
    return undefined
  }

  return {
    path: getAgentTaskRecordPath(run),
    content
  }
}

export async function publishAgentTaskResponseRecord(
  run: WorkflowRun,
  options: AgentTaskRecordPublishOptions = {}
): Promise<AgentTaskRecordPublishResult> {
  if (run.projectType !== "agent_task") {
    return { status: "skipped", reason: "not_agent_task" }
  }

  const record = createAgentTaskRecord(run)

  if (!record) {
    return { status: "skipped", reason: "missing_response_artifact" }
  }

  const repository =
    options.repository ??
    process.env.JORMUNGAND_RECORD_REPOSITORY ??
    "jormungand-record"
  const upsertFile = options.upsertFile ?? upsertGitHubFile

  return upsertFile({
    repository,
    path: record.path,
    content: record.content,
    message: `Record Agent Task response for ${run.projectName}`
  })
}

function parseMixedResponseArtifact(artifact: Artifact) {
  return {
    originalInstruction: readMarkdownSection(artifact.body, "Original Instruction"),
    rawAgentResponse: readMarkdownSection(artifact.body, "Raw Agent Response"),
    closeoutStatus: readMarkdownSection(artifact.body, "Closeout Status")
  }
}

function readMarkdownSection(body: string, title: string) {
  const marker = `**${title}**`
  const start = body.indexOf(marker)

  if (start < 0) {
    return ""
  }

  const contentStart = start + marker.length
  const nextSection = body.indexOf("\n**", contentStart)
  const raw =
    nextSection >= 0
      ? body.slice(contentStart, nextSection)
      : body.slice(contentStart)

  return raw.trim()
}

function inferCloseoutStatus(run: WorkflowRun) {
  return run.status === "failed" ? "failed" : "complete"
}
