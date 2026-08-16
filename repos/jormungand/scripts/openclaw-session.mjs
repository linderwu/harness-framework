const defaultMainAgent = "rowlet"
const conversationHistoryLimit = 12
const conversationEntryCharacterLimit = 1200

export function deriveOpenClawSessionKey(input = {}) {
  const mainAgent = sanitizeSessionSegment(
    typeof input.mainAgent === "string" && input.mainAgent.trim()
      ? input.mainAgent
      : defaultMainAgent
  )

  if (typeof input.conversationId === "string" && input.conversationId.trim()) {
    return `agent:${mainAgent}:harness-conversation-${sanitizeSessionSegment(input.conversationId)}`
  }

  const fallbackIdentity =
    typeof input.workflowRunId === "string" && input.workflowRunId.trim()
      ? input.workflowRunId
      : input.fallbackId

  return `agent:${mainAgent}:harness-${sanitizeSessionSegment(fallbackIdentity)}`
}

export function sanitizeConversationHistory(value) {
  if (!Array.isArray(value)) {
    return []
  }

  return value
    .filter((entry) => isConversationHistoryEntry(entry))
    .slice(-conversationHistoryLimit)
    .map((entry) => ({
      role: entry.role,
      content: sanitizeConversationContent(entry.content)
    }))
}

function isConversationHistoryEntry(entry) {
  return (
    entry &&
    typeof entry === "object" &&
    (entry.role === "user" || entry.role === "assistant") &&
    typeof entry.content === "string" &&
    entry.content.trim().length > 0
  )
}

function sanitizeConversationContent(value) {
  const normalized = value.trim().replaceAll(/\s+/g, " ")
  return normalized.length <= conversationEntryCharacterLimit
    ? normalized
    : normalized.slice(0, conversationEntryCharacterLimit)
}

function sanitizeSessionSegment(value) {
  const sanitized = String(value ?? "")
    .replaceAll(/[^A-Za-z0-9._-]/g, "-")

  return sanitized || "bundle"
}
