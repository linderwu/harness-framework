import {
  upsertGitHubFile,
  type GitHubFileUpsertInput,
  type GitHubFileUpsertResult
} from "./github-repository"
import type { Artifact, WorkflowRun } from "./types"

export interface AgentTaskRecord {
  path: string
  content: string
  message: string
}

export interface AgentTaskRecordPublishOptions {
  repository?: string
  upsertFile?: (input: GitHubFileUpsertInput) => Promise<GitHubFileUpsertResult>
}

export type AgentTaskRecordPublishResult =
  | (GitHubFileUpsertResult & { files?: GitHubFileUpsertResult[] })
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

function getAgentTaskRecordBasePath(run: WorkflowRun) {
  const recordDate = getRecordDateParts(run).join("-")
  return `${getRecordDatePath(run)}/${slugifyRecordTitle(run.projectName)}-${recordDate}`
}

function getRecordDatePath(run: WorkflowRun) {
  return `records/${getRecordDateParts(run).join("/")}`
}

function getRecordDateParts(run: WorkflowRun) {
  const date = new Date(run.updatedAt || run.createdAt)
  const year = String(date.getUTCFullYear())
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")

  return [year, month, day]
}

function slugifyRecordTitle(title: string) {
  const slug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")

  return slug || "agent-task"
}

export function createAgentTaskRecords(
  run: WorkflowRun
): AgentTaskRecord[] | undefined {
  const artifact = getAgentTaskResponseArtifact(run)

  if (!artifact) {
    return undefined
  }

  const sections = parseMixedResponseArtifact(artifact)
  const basePath = getAgentTaskRecordBasePath(run)
  const metadata = formatRecordMetadata(run)

  return [
    {
      path: `${basePath}-original-instruction.md`,
      content: [
        "# Original Instruction",
        "",
        ...metadata,
        "",
        "## Original Instruction",
        "",
        sections.originalInstruction || run.requirement
      ].join("\n"),
      message: `Record Agent Task original instruction for ${run.projectName}`
    },
    {
      path: `${basePath}-raw-agent-response.md`,
      content: [
        "# Raw Agent Response",
        "",
        ...metadata,
        "",
        "## Raw Agent Response",
        "",
        sections.rawAgentResponse || artifact.body,
        "",
        "## Closeout Status",
        "",
        sections.closeoutStatus || inferCloseoutStatus(run)
      ].join("\n"),
      message: `Record Agent Task raw response for ${run.projectName}`
    }
  ]
}

export function formatAgentTaskRecordMarkdown(run: WorkflowRun) {
  const records = createAgentTaskRecords(run)

  if (!records) {
    return undefined
  }

  return records.map((record) => record.content).join("\n\n")
}

function formatRecordMetadata(run: WorkflowRun) {
  return [
    `Project: ${run.projectName}`,
    `Workflow Run: ${run.id}`,
    `Project ID: ${run.projectId}`,
    `Selected Agent: ${run.selectedAgent}`,
    `Source: ${run.source}`,
    run.repository ? `Repository: ${run.repository}` : undefined,
    `Status: ${run.status}`,
    `Created: ${run.createdAt}`,
    `Updated: ${run.updatedAt}`
  ]
    .filter((line): line is string => line !== undefined)
}

export function getAgentTaskRecordPath(run: WorkflowRun) {
  return `${getAgentTaskRecordBasePath(run)}/raw-agent-response.md`
}

export function createAgentTaskRecord(
  run: WorkflowRun
): AgentTaskRecord | undefined {
  return createAgentTaskRecords(run)?.find((record) =>
    record.path.endsWith("-raw-agent-response.md")
  )
}

export async function publishAgentTaskResponseRecord(
  run: WorkflowRun,
  options: AgentTaskRecordPublishOptions = {}
): Promise<AgentTaskRecordPublishResult> {
  if (run.projectType !== "agent_task") {
    return { status: "skipped", reason: "not_agent_task" }
  }

  const records = createAgentTaskRecords(run)

  if (!records) {
    return { status: "skipped", reason: "missing_response_artifact" }
  }

  const repository =
    options.repository ??
    process.env.JORMUNGAND_RECORD_REPOSITORY ??
    "jormungand-record"
  const upsertFile = options.upsertFile ?? upsertGitHubFile

  const results = []

  for (const record of records) {
    results.push(
      await upsertFile({
        repository,
        path: record.path,
        content: record.content,
        message: record.message
      })
    )
  }

  const changedResult =
    results.find((result) => result.status === "published") ?? results[0]

  return {
    ...changedResult,
    status: results.some((result) => result.status === "published")
      ? "published"
      : "unchanged",
    files: results
  }
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
