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
export const A2A_JSONRPC_VERSION = "2.0"
export const MAX_A2A_MESSAGE_PARTS = 16
export const MAX_A2A_TEXT_PART_BYTES = 16_384
export const MAX_A2A_DATA_PART_BYTES = 65_536

export type OpenClawA2AProtocol =
  | "legacy-clawcodex-v0.1"
  | "public-a2a-v0.3"

export type A2AJsonRpcMethod = "message/send" | "message/stream"

export interface A2ATextPart {
  kind: "text"
  text: string
  metadata?: Record<string, unknown>
}

export interface A2ADataPart {
  kind: "data"
  data: unknown
  metadata?: Record<string, unknown>
}

export type A2AMessagePart = A2ATextPart | A2ADataPart

export interface ParsedA2AMessageRequest {
  jsonrpc: "2.0"
  id: string | number
  method: A2AJsonRpcMethod
  message: {
    kind: "message"
    role: "user"
    messageId: string
    contextId: string
    parts: A2AMessagePart[]
    metadata?: Record<string, unknown>
  }
  configuration?: Record<string, unknown>
  metadata?: Record<string, unknown>
  fromAgent: string
  toAgent: string
  idempotencyKey: string
  raw: Record<string, unknown>
}

export class A2AProtocolError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly status: number,
    readonly data?: Record<string, unknown>
  ) {
    super(message)
  }
}

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
  conversationId?: string
  conversationHistory?: Array<{
    role: "user" | "assistant"
    content: string
  }>
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
    fallbackBody: input.fallbackBody,
    conversationId: input.conversationId,
    conversationHistory: input.conversationHistory ?? []
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

export function parseA2AMessageRequest(
  value: unknown,
  options: { allowedMethods?: readonly A2AJsonRpcMethod[] } = {}
) {
  const request = asRecord(value)
  const allowedMethods = options.allowedMethods ?? ["message/send"]

  if (!request) {
    throw new A2AProtocolError("JSON-RPC request must be an object", -32600, 400)
  }
  if (request.jsonrpc !== A2A_JSONRPC_VERSION) {
    throw new A2AProtocolError(
      `jsonrpc must equal ${A2A_JSONRPC_VERSION}`,
      -32600,
      400
    )
  }

  const id = request.id
  if (typeof id !== "string" && typeof id !== "number") {
    throw new A2AProtocolError("id is required", -32600, 400)
  }

  const method = getString(request.method) as A2AJsonRpcMethod
  if (!allowedMethods.includes(method)) {
    throw new A2AProtocolError(
      `Unsupported method: ${getString(request.method) || String(request.method ?? "")}`,
      -32601,
      404
    )
  }

  const params = requireRecord(request.params, "params")
  const messageRecord = requireRecord(params.message, "params.message")

  if (messageRecord.kind !== "message") {
    throw new A2AProtocolError("message.kind must equal message", -32602, 400)
  }
  if (messageRecord.role !== "user") {
    throw new A2AProtocolError("message.role must equal user", -32602, 400)
  }

  const messageId = validateScopedId(getString(messageRecord.messageId), "messageId")
  const contextId = validateScopedId(getString(messageRecord.contextId), "contextId")
  const parts = parseA2AMessageParts(messageRecord.parts)
  const messageMetadata = parseOptionalRecord(messageRecord.metadata, "message.metadata")
  const configuration = parseOptionalRecord(params.configuration, "params.configuration")
  const metadata = parseOptionalRecord(params.metadata, "params.metadata")
  const fromAgent = readNonEmptyString(messageMetadata?.fromAgent) ?? "external.user"
  const toAgent = readNonEmptyString(messageMetadata?.toAgent ?? messageMetadata?.targetAgent)
  if (!toAgent) {
    throw new A2AProtocolError(
      "message.metadata.toAgent or message.metadata.targetAgent is required",
      -32602,
      400
    )
  }
  const explicitIdempotencyKey =
    readNonEmptyString(messageMetadata?.idempotencyKey) ??
    readNonEmptyString(metadata?.idempotencyKey)

  return {
    jsonrpc: A2A_JSONRPC_VERSION,
    id,
    method,
    message: {
      kind: "message" as const,
      role: "user" as const,
      messageId,
      contextId,
      parts,
      metadata: messageMetadata
    },
    configuration,
    metadata,
    fromAgent,
    toAgent,
    idempotencyKey: validateScopedId(explicitIdempotencyKey ?? "", "idempotencyKey"),
    raw: request
  } satisfies ParsedA2AMessageRequest
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

function parseA2AMessageParts(value: unknown) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new A2AProtocolError("message.parts must contain at least one part", -32602, 400)
  }
  if (value.length > MAX_A2A_MESSAGE_PARTS) {
    throw new A2AProtocolError(
      `message.parts may contain at most ${MAX_A2A_MESSAGE_PARTS} parts`,
      -32602,
      400
    )
  }

  return value.map((part) => parseA2AMessagePart(part))
}

function parseA2AMessagePart(value: unknown): A2AMessagePart {
  const record = requireRecord(value, "message.parts[]")
  const metadata = parseOptionalRecord(record.metadata, "message.parts[].metadata")

  if (record.kind === "text") {
    const text = getString(record.text)
    if (!text) {
      throw new A2AProtocolError("Text parts require text", -32602, 400)
    }
    if (Buffer.byteLength(text, "utf8") > MAX_A2A_TEXT_PART_BYTES) {
      throw new A2AProtocolError(
        `Text part exceeds the ${MAX_A2A_TEXT_PART_BYTES} byte limit`,
        -32602,
        400
      )
    }
    return { kind: "text", text, metadata }
  }

  if (record.kind === "data") {
    if (!("data" in record)) {
      throw new A2AProtocolError("Data parts require data", -32602, 400)
    }
    const serialized = stringifyDataPart(record.data)
    if (!serialized) {
      throw new A2AProtocolError("Data parts require data", -32602, 400)
    }
    if (Buffer.byteLength(serialized, "utf8") > MAX_A2A_DATA_PART_BYTES) {
      throw new A2AProtocolError(
        `Data part exceeds the ${MAX_A2A_DATA_PART_BYTES} byte limit`,
        -32602,
        400
      )
    }
    return { kind: "data", data: record.data, metadata }
  }

  throw new A2AProtocolError(
    `Unsupported message part kind: ${getString(record.kind) || String(record.kind ?? "")}`,
    -32602,
    400
  )
}

function asRecord(value: unknown) {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined
}

function getString(value: unknown) {
  return typeof value === "string" ? value : ""
}

function requireRecord(value: unknown, field: string) {
  const record = asRecord(value)
  if (!record || Array.isArray(value)) {
    throw new A2AProtocolError(`${field} must be an object`, -32602, 400)
  }
  return record
}

function parseOptionalRecord(value: unknown, field: string) {
  if (value === undefined) {
    return undefined
  }
  return requireRecord(value, field)
}

function validateScopedId(value: string, field: string) {
  const normalized = value.trim()
  if (!normalized) {
    throw new A2AProtocolError(`${field} is required`, -32602, 400)
  }
  if (!/^[A-Za-z0-9._:-]{1,200}$/.test(normalized)) {
    throw new A2AProtocolError(
      `${field} must use only letters, numbers, dot, underscore, colon, or hyphen`,
      -32602,
      400
    )
  }
  return normalized
}

function readNonEmptyString(value: unknown) {
  const text = getString(value).trim()
  return text || undefined
}
