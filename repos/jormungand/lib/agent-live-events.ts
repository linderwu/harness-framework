import { agentProfiles } from "./agents"
import type { AgentKind } from "./types"

export const MAX_AGENT_LIVE_TEXT = 8_000
export const MAX_AGENT_LIVE_EVENTS = 64

export type AgentLiveEventType =
  | "started"
  | "status"
  | "tool"
  | "assistant_delta"
  | "reasoning"
  | "completed"
  | "failed"

export interface AgentLiveEvent {
  id: string
  sequence: number
  conversationId: string
  agentId: AgentKind
  type: AgentLiveEventType
  message?: string
  text?: string
  delta?: string
  createdAt: string
  metadata?: { runId?: string; source?: string; phase?: string }
}

const agentKindSet = new Set<AgentKind>(agentProfiles.map((agent) => agent.id))
const agentLiveEventTypes = new Set<AgentLiveEventType>([
  "started",
  "status",
  "tool",
  "assistant_delta",
  "reasoning",
  "completed",
  "failed"
])

export function normalizeAgentLiveEvent(input: unknown): AgentLiveEvent {
  const value = asRecord(input, "Live event payload must be an object.")
  const conversationId = readRequiredString(value.conversationId, "conversationId")
  const agentId = readAgentKind(value.agentId)
  const type = readEventType(value.type)
  const metadata = normalizeMetadata(value.metadata)

  return {
    id: readOptionalString(value.id) ?? crypto.randomUUID(),
    sequence: readSequence(value.sequence),
    conversationId,
    agentId,
    type,
    message: normalizeBoundedText(value.message),
    text: normalizeBoundedText(value.text),
    delta: normalizeBoundedDelta(value.delta),
    createdAt: readOptionalString(value.createdAt) ?? new Date().toISOString(),
    metadata
  }
}

export function extractReasoningText(input: unknown): string | undefined {
  const value = asRecord(input)

  for (const field of ["reasoning", "thinking", "reasoning_content"] as const) {
    const text = normalizeBoundedText(value[field])
    if (text) {
      return text
    }
  }

  const text = typeof value.text === "string" ? value.text : undefined
  if (!text) {
    return undefined
  }

  const match = /<think>([\s\S]*?)<\/think>/i.exec(text)
  return match ? normalizeBoundedText(match[1]) : undefined
}

function asRecord(value: unknown, errorMessage = "Expected an object."): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(errorMessage)
  }

  return value as Record<string, unknown>
}

function readRequiredString(value: unknown, fieldName: string) {
  const text = readOptionalString(value)
  if (!text) {
    throw new Error(`${fieldName} must be a non-empty string.`)
  }

  return text
}

function readOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }

  const text = value.trim()
  return text ? text : undefined
}

function readAgentKind(value: unknown): AgentKind {
  const agentId = readRequiredString(value, "agentId")
  if (!agentKindSet.has(agentId as AgentKind)) {
    throw new Error(`Unsupported agentId: ${agentId}.`)
  }

  return agentId as AgentKind
}

function readEventType(value: unknown): AgentLiveEventType {
  const type = readRequiredString(value, "type")
  if (!agentLiveEventTypes.has(type as AgentLiveEventType)) {
    throw new Error(`Unsupported live event type: ${type}.`)
  }

  return type as AgentLiveEventType
}

function readSequence(value: unknown) {
  if (value === undefined) {
    return 0
  }

  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error("sequence must be a non-negative integer.")
  }

  return value
}

function normalizeBoundedText(value: unknown) {
  const text = readOptionalString(value)
  if (!text) {
    return undefined
  }

  return text.slice(0, MAX_AGENT_LIVE_TEXT)
}

function normalizeBoundedDelta(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    return undefined
  }

  return value.slice(0, MAX_AGENT_LIVE_TEXT)
}

function normalizeMetadata(value: unknown): AgentLiveEvent["metadata"] | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined
  }

  const metadata = value as Record<string, unknown>
  const normalized = {
    runId: normalizeBoundedText(metadata.runId),
    source: normalizeBoundedText(metadata.source),
    phase: normalizeBoundedText(metadata.phase)
  }

  return normalized.runId || normalized.source || normalized.phase
    ? normalized
    : undefined
}
