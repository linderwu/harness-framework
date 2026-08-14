import type {
  AgentKind,
  Artifact,
  OpenClawMainAgent,
  WorkflowEventSkill,
  WorkflowRun,
  WorkflowStage
} from "@/lib/types"

export const PUBLIC_A2A_PROTOCOL_VERSION = "0.3.0"
export const LEGACY_CLAWCODEX_A2A_VERSION = "0.1"

export type OpenClawA2AProtocol =
  | "legacy-clawcodex-v0.1"
  | "public-a2a-v0.3"

interface OpenClawA2AEnvelopeInput {
  run: WorkflowRun
  skill: WorkflowEventSkill
  executor: AgentKind
  stage: WorkflowStage
  artifactType: Artifact["type"]
  title: string
  fallbackBody: string
  idempotencyKey: string
  sessionKey: string
  mainAgent?: OpenClawMainAgent
}

interface BridgeLikeResponse {
  output?: string
  error?: string
  stderr?: string
  result?: unknown
}

export function resolveOpenClawA2AProtocol(
  value = process.env.OPENCLAW_A2A_PROTOCOL
): OpenClawA2AProtocol {
  return value === "public-a2a-v0.3" || value === "a2a-v0.3"
    ? "public-a2a-v0.3"
    : "legacy-clawcodex-v0.1"
}

export function createOpenClawA2AEnvelope(
  input: OpenClawA2AEnvelopeInput,
  protocol: OpenClawA2AProtocol
) {
  return protocol === "public-a2a-v0.3"
    ? createPublicA2ASendMessageRequest(input)
    : createLegacyClawCodexEnvelope(input)
}

function createPublicA2ASendMessageRequest(input: OpenClawA2AEnvelopeInput) {
  const targetAgent = input.mainAgent ?? "rowlet"

  return {
    jsonrpc: "2.0",
    id: input.idempotencyKey,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: input.idempotencyKey,
        contextId: input.sessionKey,
        parts: [
          {
            kind: "data",
            data: createTaskPayload(input),
            metadata: {
              mimeType: "application/vnd.harness.workflow-task+json"
            }
          }
        ],
        metadata: {
          title: input.title,
          executor: input.executor,
          targetAgent: `openclaw:${targetAgent}`
        }
      },
      configuration: {
        acceptedOutputModes: ["text/plain", "application/json"],
        blocking: true
      },
      metadata: {
        protocolVersion: PUBLIC_A2A_PROTOCOL_VERSION,
        compatibility: "harness-openclaw-a2a",
        skillId: input.skill.id,
        stage: input.stage,
        artifactType: input.artifactType
      }
    }
  } as const
}

function createLegacyClawCodexEnvelope(input: OpenClawA2AEnvelopeInput) {
  const targetAgent = input.mainAgent ?? "rowlet"

  return {
    protocol: "ClawCodex-A2A",
    version: LEGACY_CLAWCODEX_A2A_VERSION,
    msg_id: input.idempotencyKey,
    in_reply_to: null,
    from: "harness",
    to: `openclaw:${targetAgent}`,
    intent: "task",
    summary: input.title,
    body: JSON.stringify(createTaskPayload(input)),
    artifacts: [],
    requested_action: "reply",
    constraints: input.skill.constraints,
    status: "accepted",
    futureProtocol: {
      name: "Agent2Agent",
      version: PUBLIC_A2A_PROTOCOL_VERSION,
      jsonrpcMethod: "message/send"
    }
  } as const
}

function createTaskPayload(input: OpenClawA2AEnvelopeInput) {
  return {
    workflowRunId: input.run.id,
    workflowVersion: input.run.version,
    projectName: input.run.projectName,
    repository: input.run.repository,
    requirement: input.run.requirement,
    contextFiles: input.run.contextFiles ?? [],
    stage: input.stage,
    artifactType: input.artifactType,
    title: input.title,
    executor: input.executor,
    skill: input.skill,
    artifacts: input.run.artifacts,
    fallbackBody: input.fallbackBody
  }
}

export function extractA2AResponseText(raw: string) {
  try {
    const data = JSON.parse(raw) as BridgeLikeResponse
    const jsonRpcError = getString(asRecord(data.error)?.message)
    const result = asRecord(data.result)
    const directMessage = collectMessageText(result)
    const wrappedMessage = collectMessageText(result?.message)
    const taskStatusMessage = collectMessageText(asRecord(result?.status)?.message)
    const artifactText = collectArtifactsText(result?.artifacts)
    const wrappedTaskArtifactText = collectArtifactsText(
      asRecord(result?.task)?.artifacts
    )
    const legacyPayloadText = collectLegacyPayloadText(result?.payloads)

    return (
      directMessage ||
      wrappedMessage ||
      taskStatusMessage ||
      artifactText ||
      wrappedTaskArtifactText ||
      legacyPayloadText ||
      data.output ||
      jsonRpcError ||
      data.error ||
      data.stderr ||
      raw
    )
  } catch {
    return raw
  }
}

function collectMessageText(value: unknown) {
  const message = asRecord(value)
  return collectPartsText(message?.parts)
}

function collectArtifactsText(value: unknown) {
  if (!Array.isArray(value)) {
    return ""
  }

  return value
    .map((artifact) => collectPartsText(asRecord(artifact)?.parts))
    .filter(Boolean)
    .join("\n")
}

function collectLegacyPayloadText(value: unknown) {
  if (!Array.isArray(value)) {
    return ""
  }

  return value
    .map((payload) => getString(asRecord(payload)?.text))
    .filter(Boolean)
    .join("\n")
}

function collectPartsText(value: unknown) {
  if (!Array.isArray(value)) {
    return ""
  }

  return value
    .map((part) => {
      const record = asRecord(part)
      return getString(record?.text) || stringifyDataPart(record?.data)
    })
    .filter(Boolean)
    .join("\n")
}

function stringifyDataPart(value: unknown) {
  return value === undefined ? "" : JSON.stringify(value)
}

function asRecord(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(value: unknown) {
  return typeof value === "string" ? value : ""
}
