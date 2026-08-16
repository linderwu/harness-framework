import type { HiveMemoryRepository } from "@/lib/hive-memory/repository"
import type { ConversationEntry } from "@/lib/hive-memory/types"

export const codexConversationId = "global:unbound-conversation"

export interface CodexConversationEvent {
  id: string
  sequence: number
  createdAt: string
  type: string
  message?: string
  text?: string
  turnId?: string
  itemId?: string
}

export interface CodexConversationState {
  entries: ConversationEntry[]
  allowedAgents: import("@/lib/types").AgentKind[]
  session?: {
    id: string
    threadId: string
    status: string
    turnStatus: string
    currentTurnId?: string
    cursor: number
    finalText?: string
    liveText?: string
  }
  events: CodexConversationEvent[]
  nextCursor: number
}

interface BridgeSessionSnapshot {
  id: string
  threadId: string
  status: string
  turnStatus: string
  currentTurnId?: string
  cursor: number
  finalText?: string
  liveText?: string
}

interface BridgeEventsResponse extends BridgeSessionSnapshot {
  events: CodexConversationEvent[]
  nextCursor: number
}

export async function getCodexConversationState(
  repository: HiveMemoryRepository
): Promise<CodexConversationState> {
  const session = repository.getCodexSession(codexConversationId)
  if (!session) {
    return {
      entries: repository.listConversation(codexConversationId),
      allowedAgents: ["codex"],
      events: [],
      nextCursor: 0
    }
  }

  const bridgeState = await readBridgeEvents(session.bridgeSessionId, session.cursor)

  if (!bridgeState) {
    await repository.updateCodexSession({
      conversationId: codexConversationId,
      status: "offline"
    })
    return {
      entries: repository.listConversation(codexConversationId),
      allowedAgents: ["codex"],
      session: toSessionState(session),
      events: [],
      nextCursor: session.cursor
    }
  }

  await syncConversation(repository, bridgeState)
  const refreshedSession = repository.getCodexSession(codexConversationId) ?? session

  return {
    entries: repository.listConversation(codexConversationId),
    allowedAgents: ["codex"],
    session: toSessionState({
      ...refreshedSession,
      status: bridgeState.status,
      turnStatus: bridgeState.turnStatus,
      currentTurnId: bridgeState.currentTurnId,
      cursor: bridgeState.nextCursor
    }, bridgeState),
    events: bridgeState.events,
    nextCursor: bridgeState.nextCursor
  }
}

export async function postCodexConversationMessage(input: {
  repository: HiveMemoryRepository
  content: string
  idempotencyKey: string
}) {
  const content = input.content.trim()
  if (!content) throw new CodexConversationError("content is required", 400)
  if (!input.idempotencyKey.trim()) {
    throw new CodexConversationError("idempotencyKey is required", 400)
  }

  const existing = input.repository.getConversationByIdempotencyKey(input.idempotencyKey)
  if (existing) {
    return {
      userEntry: existing,
      responseEntry: input.repository.getConversationByIdempotencyKey(`${input.idempotencyKey}:response`),
      duplicate: true,
      ...(await getCodexConversationState(input.repository))
    }
  }

  const session = await ensureCodexSession(input.repository)
  const userInsert = await input.repository.insertConversation({
    workflowRunId: codexConversationId,
    role: "user",
    agentId: "codex",
    content,
    importance: "normal",
    status: "running",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: input.idempotencyKey
  })
  const userEntry = userInsert.entry

  try {
    await bridgeRequest(`/sessions/${encodeURIComponent(session.bridgeSessionId)}/turns`, {
      method: "POST",
      body: JSON.stringify({ content })
    })
    await input.repository.updateCodexSession({
      conversationId: codexConversationId,
      status: "running",
      turnStatus: "inProgress"
    })
  } catch (error) {
    await input.repository.updateConversation({ id: userEntry.id, status: "failed" })
    throw error
  }

  const responseInsert = await input.repository.insertConversation({
    workflowRunId: codexConversationId,
    role: "agent",
    agentId: "codex",
    content: "Codex is working…",
    importance: "important",
    status: "running",
    replyToId: userEntry.id,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: `${input.idempotencyKey}:response`
  })

  return {
    userEntry,
    responseEntry: responseInsert.entry,
    duplicate: false,
    ...(await getCodexConversationState(input.repository))
  }
}

export async function controlCodexConversation(
  repository: HiveMemoryRepository,
  action: "interrupt" | "resume" | "stop"
) {
  const session = repository.getCodexSession(codexConversationId)
  if (!session) throw new CodexConversationError("Codex conversation has not started", 404)

  await bridgeRequest(`/sessions/${encodeURIComponent(session.bridgeSessionId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({})
  })
  return getCodexConversationState(repository)
}

async function ensureCodexSession(repository: HiveMemoryRepository) {
  const existing = repository.getCodexSession(codexConversationId)
  if (existing) {
    const existingState = await readBridgeEvents(existing.bridgeSessionId, existing.cursor)
    if (existingState && existingState.status !== "stopped" && existingState.status !== "failed") {
      return existing
    }
  }

  const created = await bridgeRequest("/sessions", {
    method: "POST",
    body: JSON.stringify({})
  }) as BridgeSessionSnapshot

  const session = await repository.upsertCodexSession({
    conversationId: codexConversationId,
    bridgeSessionId: created.id,
    codexThreadId: created.threadId,
    status: created.status,
    turnStatus: created.turnStatus,
    currentTurnId: created.currentTurnId,
    cursor: created.cursor
  })
  if (!session) throw new Error("Codex session could not be persisted.")
  return session
}

async function syncConversation(
  repository: HiveMemoryRepository,
  bridgeState: BridgeEventsResponse
) {
  const entries = repository.listConversation(codexConversationId)
  const responseEntry = [...entries].reverse().find(
    (entry) => entry.role === "agent" && entry.status === "running"
  )
  const userEntry = responseEntry
    ? entries.find((entry) => entry.id === responseEntry.replyToId)
    : undefined
  const activityText = [...bridgeState.events]
    .reverse()
    .find((event) => event.message?.trim())?.message
  const isCompleted = bridgeState.status === "idle" && bridgeState.turnStatus === "completed"
  const isFailed = bridgeState.status === "failed" || bridgeState.turnStatus === "failed"
  const isPaused = bridgeState.status === "paused" || bridgeState.turnStatus === "interrupted"
  const responseContent = bridgeState.finalText?.trim() ||
    bridgeState.liveText?.trim() ||
    (isPaused ? "Codex paused. Choose Continue to resume this session." :
      isFailed ? activityText || "Codex failed to complete this turn." :
        activityText || "Codex is working…")

  if (responseEntry) {
    await repository.updateConversation({
      id: responseEntry.id,
      content: responseContent,
      status: isCompleted ? "completed" : isFailed ? "failed" : "running"
    })
  }
  if (userEntry) {
    await repository.updateConversation({
      id: userEntry.id,
      status: isCompleted ? "completed" : isFailed ? "failed" : "running"
    })
  }
  await repository.updateCodexSession({
    conversationId: codexConversationId,
    status: bridgeState.status,
    turnStatus: bridgeState.turnStatus,
    currentTurnId: bridgeState.currentTurnId,
    cursor: bridgeState.nextCursor
  })
}

async function readBridgeEvents(bridgeSessionId: string, cursor: number) {
  try {
    return await bridgeRequest(
      `/sessions/${encodeURIComponent(bridgeSessionId)}/events?after=${cursor}`,
      { method: "GET" }
    ) as BridgeEventsResponse
  } catch {
    return undefined
  }
}

async function bridgeRequest(path: string, init: RequestInit) {
  const bridgeUrl = process.env.CODEX_BRIDGE_URL?.trim()
  if (!bridgeUrl) {
    throw new CodexConversationError(
      "Codex bridge is not configured. Set CODEX_BRIDGE_URL.",
      503
    )
  }

  const headers = new Headers(init.headers)
  headers.set("Content-Type", "application/json")
  const token = process.env.CODEX_BRIDGE_TOKEN?.trim()
  if (token) headers.set("Authorization", `Bearer ${token}`)

  const response = await fetch(new URL(path.replace(/^\//, ""), normalizeUrl(bridgeUrl)), {
    ...init,
    headers,
    cache: "no-store"
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    throw new CodexConversationError(
      data.error ?? `Codex bridge request failed with HTTP ${response.status}.`,
      response.status
    )
  }
  return data
}

function toSessionState(
  session: {
    bridgeSessionId: string
    codexThreadId: string
    status: string
    turnStatus: string
    currentTurnId?: string
    cursor: number
  },
  bridgeState?: BridgeSessionSnapshot
) {
  return {
    id: session.bridgeSessionId,
    threadId: session.codexThreadId,
    status: bridgeState?.status ?? session.status,
    turnStatus: bridgeState?.turnStatus ?? session.turnStatus,
    currentTurnId: bridgeState?.currentTurnId ?? session.currentTurnId,
    cursor: bridgeState?.cursor ?? session.cursor,
    finalText: bridgeState?.finalText,
    liveText: bridgeState?.liveText
  }
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}

export class CodexConversationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}
