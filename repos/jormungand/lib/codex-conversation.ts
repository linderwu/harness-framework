import { formatSharedConversationPrompt } from "./conversation-history"
import { ConversationHistorySync } from "./conversation-history-sync"
import { projectNativeThread, type NativeTurn } from "./codex-thread-sync"
import type { HiveMemoryRepository } from "./hive-memory/repository"
import type { ConversationEntry } from "./hive-memory/types"

export const codexConversationId = "global:unbound-conversation"

const codexConversationSync = new ConversationHistorySync()

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
  conversationId: string
  entries: ConversationEntry[]
  allowedAgents: import("./types").AgentKind[]
  session?: {
    id: string
    threadId: string
    status: string
    turnStatus: string
    currentTurnId?: string
    cursor: number
    mappingState?: string
    replacementOfThreadId?: string
    nativeName?: string
    nativeCursor?: string
    lastSyncAt?: string
    syncWarning?: string
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

interface BridgeThreadResponse extends BridgeSessionSnapshot {
  thread?: {
    id: string
    name?: string | null
    turns?: NativeTurn[]
  }
}

export async function getCodexConversationState(
  repository: HiveMemoryRepository,
  conversationId = codexConversationId,
  recoveryAttempt = false
): Promise<CodexConversationState> {
  const session = repository.getCodexSession(conversationId)
  if (!session) {
    return {
      conversationId,
      entries: repository.listConversation(conversationId),
      allowedAgents: ["codex"],
      events: [],
      nextCursor: 0
    }
  }

  const bridgeState = await readBridgeEvents(session.bridgeSessionId, session.cursor)

  if (!bridgeState) {
    if (!recoveryAttempt) {
      try {
        await ensureCodexSession(repository, conversationId)
        return getCodexConversationState(repository, conversationId, true)
      } catch {
        // Preserve the durable mapping and expose the offline state below.
      }
    }
    await repository.updateCodexSession({
      conversationId,
      bridgeSessionId: session.bridgeSessionId,
      status: "offline",
      mappingState: "offline"
    })
    return {
      conversationId,
      entries: repository.listConversation(conversationId),
      allowedAgents: ["codex"],
      session: toSessionState(session),
      events: [],
      nextCursor: session.cursor
    }
  }

  await syncConversation(repository, conversationId, bridgeState, session.bridgeSessionId)
  let bridgeThread: BridgeThreadResponse | undefined
  try {
    bridgeThread = await readBridgeThread(session.bridgeSessionId)
  } catch (error) {
    if (error instanceof CodexConversationError && error.status === 404) {
      await repository.updateCodexSession({
        conversationId,
        bridgeSessionId: session.bridgeSessionId,
        status: "offline",
        mappingState: "replacement_pending"
      })
    }
  }
  if (bridgeThread?.thread?.turns) {
    await syncNativeThread(repository, conversationId, bridgeThread.thread)
    await repository.updateCodexSession({
      conversationId,
      bridgeSessionId: session.bridgeSessionId,
      mappingState: "active",
      nativeName: bridgeThread.thread.name ?? undefined,
      nativeCursor: latestNativeTurnId(bridgeThread.thread.turns),
      lastSyncAt: new Date().toISOString()
    })
  }
  const refreshedSession = repository.getCodexSession(conversationId) ?? session
  const effectiveCursor = Math.max(
    refreshedSession.cursor,
    bridgeState.cursor,
    bridgeState.nextCursor
  )

  return {
    conversationId,
    entries: repository.listConversation(conversationId),
    allowedAgents: ["codex"],
    session: toSessionState(
      {
        ...refreshedSession,
        status: bridgeState.status,
        turnStatus: bridgeState.turnStatus,
        currentTurnId: bridgeState.currentTurnId,
        cursor: effectiveCursor
      },
      { ...bridgeState, cursor: effectiveCursor }
    ),
    events: bridgeState.events,
    nextCursor: effectiveCursor
  }
}

export async function postCodexConversationMessage(input: {
  repository: HiveMemoryRepository
  conversationId?: string
  content: string
  idempotencyKey: string
}) {
  const conversationId = input.conversationId ?? codexConversationId
  const content = input.content.trim()
  const storageIdempotencyKey = toConversationScopedIdempotencyKey(
    conversationId,
    input.idempotencyKey
  )

  if (!content) throw new CodexConversationError("content is required", 400)
  if (!input.idempotencyKey.trim()) {
    throw new CodexConversationError("idempotencyKey is required", 400)
  }

  const existing = input.repository.getConversationByIdempotencyKey(storageIdempotencyKey)
  if (existing) {
    return {
      userEntry: existing,
      responseEntry: input.repository.getConversationByIdempotencyKey(
        `${storageIdempotencyKey}:response`
      ),
      duplicate: true,
      ...(await getCodexConversationState(input.repository, conversationId))
    }
  }

  const session = await ensureCodexSession(input.repository, conversationId)
  const userInsert = await input.repository.insertConversation({
    workflowRunId: conversationId,
    role: "user",
    agentId: "codex",
    content,
    importance: "normal",
    status: "running",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: storageIdempotencyKey
  })
  const userEntry = userInsert.entry
  const sessionIdentity = `${session.bridgeSessionId}:${session.codexThreadId}`
  const syncKey = `codex:${conversationId}`
  const delta = codexConversationSync.getDelta({
    key: syncKey,
    sessionIdentity,
    targetAgent: "codex",
    entries: input.repository.listConversation(conversationId)
  })
  const requestContent = formatSharedConversationPrompt(delta.history)

  try {
    const turnResult = await bridgeRequest(`/sessions/${encodeURIComponent(session.bridgeSessionId)}/turns`, {
      method: "POST",
      body: JSON.stringify({ content: requestContent })
    })
    await recordHarnessTurnStart(
      input.repository,
      conversationId,
      session,
      userEntry,
      turnResult,
      requestContent
    )
    codexConversationSync.markDelivered({
      key: syncKey,
      sessionIdentity,
      cursorEntryId: delta.cursorEntryId
    })
    await input.repository.updateCodexSession({
      conversationId,
      bridgeSessionId: session.bridgeSessionId,
      status: "running",
      turnStatus: "inProgress"
    })
  } catch (error) {
    await input.repository.updateConversation({ id: userEntry.id, status: "failed" })
    throw error
  }

  const responseInsert = await input.repository.insertConversation({
    workflowRunId: conversationId,
    role: "agent",
    agentId: "codex",
    content: "Codex is working...",
    importance: "important",
    status: "running",
    replyToId: userEntry.id,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: `${storageIdempotencyKey}:response`
  })

  return {
    userEntry,
    responseEntry: responseInsert.entry,
    duplicate: false,
    ...(await getCodexConversationState(input.repository, conversationId))
  }
}

export async function dispatchCodexConversationEntry(input: {
  repository: HiveMemoryRepository
  conversationId: string
  userEntryId: string
  responseEntryId?: string
  pollIntervalMs?: number
  maxPollAttempts?: number
}) {
  const userEntry = input.repository.getConversationEntry(input.userEntryId)
  if (!userEntry || userEntry.workflowRunId !== input.conversationId) {
    throw new CodexConversationError("Conversation message could not be found", 404)
  }
  const responseEntry = input.responseEntryId
    ? input.repository.getConversationEntry(input.responseEntryId)
    : undefined
  await input.repository.updateConversation({ id: userEntry.id, status: "running" })
  if (responseEntry) {
    await input.repository.updateConversation({ id: responseEntry.id, status: "running" })
  }

  const session = await ensureCodexSession(input.repository, input.conversationId)
  const entries = input.repository.listConversation(input.conversationId)
  const userIndex = entries.findIndex((entry) => entry.id === userEntry.id)
  const entriesThroughCurrent = userIndex === -1 ? [userEntry] : entries.slice(0, userIndex + 1)
  const sessionIdentity = `${session.bridgeSessionId}:${session.codexThreadId}`
  const syncKey = `codex:${input.conversationId}`
  const delta = codexConversationSync.getDelta({
    key: syncKey,
    sessionIdentity,
    targetAgent: "codex",
    entries: entriesThroughCurrent
  })
  const requestContent = formatSharedConversationPrompt(delta.history)

  const turnResult = await bridgeRequest(`/sessions/${encodeURIComponent(session.bridgeSessionId)}/turns`, {
    method: "POST",
    body: JSON.stringify({ content: requestContent })
  })
  await recordHarnessTurnStart(
    input.repository,
    input.conversationId,
    session,
    userEntry,
    turnResult,
    requestContent
  )
  codexConversationSync.markDelivered({
    key: syncKey,
    sessionIdentity,
    cursorEntryId: delta.cursorEntryId
  })
  await input.repository.updateCodexSession({
    conversationId: input.conversationId,
    bridgeSessionId: session.bridgeSessionId,
    status: "running",
    turnStatus: "inProgress"
  })

  const pollIntervalMs = Math.max(1, input.pollIntervalMs ?? 1_000)
  const maxPollAttempts = input.maxPollAttempts ?? 300
  for (let attempt = 0; attempt < maxPollAttempts; attempt += 1) {
    const state = await getCodexConversationState(input.repository, input.conversationId)
    const turnStatus = state.session?.turnStatus
    if (turnStatus && turnStatus !== "inProgress") {
      const responseEntry = input.responseEntryId
        ? input.repository.getConversationEntry(input.responseEntryId)
        : [...state.entries].reverse().find(
          (entry) => entry.role === "agent" && entry.replyToId === input.userEntryId
        )
      const status = turnStatus === "completed"
        ? "completed" as const
        : turnStatus === "interrupted"
          || turnStatus === "stopped"
          || state.session?.status === "paused"
          || state.session?.status === "stopped"
          ? "interrupted" as const
          : "failed" as const
      return {
        status,
        body: responseEntry?.content
          ?? state.session?.finalText
          ?? state.session?.liveText
          ?? (status === "interrupted" ? "Codex response interrupted." : "Codex response failed.")
      }
    }
    await delay(pollIntervalMs)
  }

  throw new CodexConversationError("Codex turn did not reach a terminal state.", 504)
}

export async function controlCodexConversation(
  repository: HiveMemoryRepository,
  action: "interrupt" | "resume" | "stop",
  conversationId = codexConversationId
) {
  const session = repository.getCodexSession(conversationId)
  if (!session) {
    if (action === "resume") {
      throw new CodexConversationError("Codex conversation has not started", 404)
    }
    return getCodexConversationState(repository, conversationId)
  }

  await bridgeRequest(`/sessions/${encodeURIComponent(session.bridgeSessionId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({})
  })
  return getCodexConversationState(repository, conversationId)
}

export async function stopCodexConversationSession(
  repository: HiveMemoryRepository,
  conversationId = codexConversationId
) {
  await controlCodexConversation(repository, "stop", conversationId)
}

export async function renameCodexConversationThread(
  repository: HiveMemoryRepository,
  conversationId: string,
  name: string
) {
  const session = repository.getCodexSession(conversationId)
  if (!session) return
  await bridgeRequest(`/sessions/${encodeURIComponent(session.bridgeSessionId)}/name`, {
    method: "POST",
    body: JSON.stringify({ name })
  })
  await repository.updateCodexSession({
    conversationId,
    bridgeSessionId: session.bridgeSessionId,
    nativeName: name,
    mappingState: "active"
  })
}

export async function setCodexConversationThreadState(
  repository: HiveMemoryRepository,
  conversationId: string,
  state: "active" | "archived"
) {
  const session = repository.getCodexSession(conversationId)
  if (!session) return
  const action = state === "archived" ? "archive" : "unarchive"
  await bridgeRequest(`/sessions/${encodeURIComponent(session.bridgeSessionId)}/${action}`, {
    method: "POST",
    body: JSON.stringify({})
  })
  await repository.updateCodexSession({
    conversationId,
    bridgeSessionId: session.bridgeSessionId,
    mappingState: state
  })
}

export async function deleteCodexConversationThread(
  repository: HiveMemoryRepository,
  conversationId: string
) {
  const session = repository.getCodexSession(conversationId)
  if (!session) return
  await bridgeRequest(`/sessions/${encodeURIComponent(session.bridgeSessionId)}/delete`, {
    method: "POST",
    body: JSON.stringify({})
  })
  await repository.updateCodexSession({
    conversationId,
    bridgeSessionId: session.bridgeSessionId,
    mappingState: "deleted"
  })
}

async function ensureCodexSession(
  repository: HiveMemoryRepository,
  conversationId: string
) {
  const existing = repository.getCodexSession(conversationId)
  if (existing) {
    const existingState = await readBridgeEvents(existing.bridgeSessionId, existing.cursor)
    if (
      existingState &&
      existingState.status !== "stopped" &&
      existingState.status !== "failed" &&
      existing.mappingState !== "replacement_pending" &&
      existing.mappingState !== "native_deleted"
    ) {
      return existing
    }
  }

  const nativeName = existing?.nativeName ?? codexThreadName(repository, conversationId)
  const resumeBody = {
    threadId: existing?.codexThreadId,
    name: nativeName
  }
  let replacementOfThreadId = existing?.replacementOfThreadId
  let created: BridgeSessionSnapshot
  try {
    created = (await bridgeRequest("/sessions", {
      method: "POST",
      body: JSON.stringify(resumeBody)
    })) as BridgeSessionSnapshot
  } catch (error) {
    if (!existing || !(error instanceof CodexConversationError) || error.status !== 404) {
      throw error
    }
    replacementOfThreadId = existing.codexThreadId
    created = (await bridgeRequest("/sessions", {
      method: "POST",
      body: JSON.stringify({ name: nativeName })
    })) as BridgeSessionSnapshot
  }

  const session = await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: created.id,
    codexThreadId: created.threadId,
    status: created.status,
    turnStatus: created.turnStatus,
    currentTurnId: created.currentTurnId,
    cursor: created.cursor,
    mappingState: existing?.mappingState ?? "active",
    replacementOfThreadId,
    nativeName,
    nativeCursor: existing?.nativeCursor,
    lastSyncAt: existing?.lastSyncAt
  })
  if (!session) throw new Error("Codex session could not be persisted.")
  return session
}

async function syncConversation(
  repository: HiveMemoryRepository,
  conversationId: string,
  bridgeState: BridgeEventsResponse,
  bridgeSessionId: string
) {
  const entries = repository.listConversation(conversationId)
  const responseEntry = [...entries].reverse().find(
    (entry) => entry.role === "agent" && entry.status === "running"
  )
  const userEntry = responseEntry
    ? entries.find((entry) => entry.id === responseEntry.replyToId)
    : undefined
  const activityText = [...bridgeState.events]
    .reverse()
    .find((event) => event.message?.trim())?.message
  const isCompleted =
    bridgeState.status === "idle" && bridgeState.turnStatus === "completed"
  const isFailed =
    bridgeState.status === "failed" || bridgeState.turnStatus === "failed"
  const isPaused =
    bridgeState.status === "paused" || bridgeState.turnStatus === "interrupted"
  const responseContent =
    bridgeState.finalText?.trim() ||
    bridgeState.liveText?.trim() ||
    (isPaused
      ? "Codex paused. Choose Continue to resume this session."
      : isFailed
        ? activityText || "Codex failed to complete this turn."
        : activityText || "Codex is working...")

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
    conversationId,
    bridgeSessionId,
    status: bridgeState.status,
    turnStatus: bridgeState.turnStatus,
    currentTurnId: bridgeState.currentTurnId,
    cursor: bridgeState.nextCursor
  })
}

async function syncNativeThread(
  repository: HiveMemoryRepository,
  conversationId: string,
  thread: NonNullable<BridgeThreadResponse["thread"]>
) {
  const ledgerItems = repository.listCodexSyncItems(conversationId)
  const harnessTurnIds = new Set(
    ledgerItems
      .filter((item) => item.source === "harness")
      .map((item) => item.nativeTurnId)
  )
  const ledgerKeys = new Set(
    ledgerItems.map((item) => `${item.nativeThreadId}:${item.nativeTurnId}:${item.nativeItemId}`)
  )
  const projection = projectNativeThread({
    conversationId,
    nativeThreadId: thread.id,
    turns: thread.turns ?? [],
    harnessTurnIds,
    ledgerKeys
  })
  const nativeUserEntries = new Map(
    ledgerItems
      .filter((item) => item.source === "harness" && item.conversationEntryId)
      .map((item) => [item.nativeTurnId, item.conversationEntryId!] as const)
  )

  for (const projected of projection.entries) {
    let conversationEntryId: string
    const replyToId = projected.replyToNativeTurnId
      ? nativeUserEntries.get(projected.replyToNativeTurnId)
      : undefined

    if (projected.role === "user") {
      const inserted = await repository.insertConversation({
        workflowRunId: conversationId,
        role: "user",
        agentId: "codex",
        content: projected.content,
        importance: "normal",
        status: projected.status,
        artifactIds: [],
        memoryIds: [],
        idempotencyKey: projected.idempotencyKey
      })
      conversationEntryId = inserted.entry.id
      nativeUserEntries.set(projected.nativeTurnId, conversationEntryId)
    } else {
      const conversationEntries = repository.listConversation(conversationId)
      const fallbackReplyToId = [...conversationEntries]
        .reverse()
        .find((entry) => entry.role === "user")?.id
      const responseReplyToId = replyToId ?? fallbackReplyToId
      const existingResponse = responseReplyToId
        ? [...conversationEntries]
          .reverse()
          .find((entry) => entry.role === "agent" && entry.replyToId === responseReplyToId && entry.agentId === "codex")
        : undefined
      if (existingResponse) {
        await repository.updateConversation({
          id: existingResponse.id,
          content: projected.content,
          status: projected.status
        })
        conversationEntryId = existingResponse.id
      } else {
        const inserted = await repository.insertConversation({
          workflowRunId: conversationId,
          role: "agent",
          agentId: "codex",
          content: projected.content,
          importance: "important",
          status: projected.status,
          replyToId,
          artifactIds: [],
          memoryIds: [],
          idempotencyKey: projected.idempotencyKey
        })
        conversationEntryId = inserted.entry.id
      }
    }

    await repository.recordCodexSyncItem({
      conversationId,
      nativeThreadId: projected.nativeThreadId,
      nativeTurnId: projected.nativeTurnId,
      nativeItemId: projected.nativeItemId,
      source: projected.source,
      kind: projected.role === "user" ? "userMessage" : "agentMessage",
      conversationEntryId,
      contentHash: projected.content
    })
  }
}

async function readBridgeEvents(bridgeSessionId: string, cursor: number) {
  try {
    return (await bridgeRequest(
      `/sessions/${encodeURIComponent(bridgeSessionId)}/events?after=${cursor}`,
      { method: "GET" }
    )) as BridgeEventsResponse
  } catch {
    return undefined
  }
}

async function readBridgeThread(bridgeSessionId: string) {
  try {
    return (await bridgeRequest(
      `/sessions/${encodeURIComponent(bridgeSessionId)}/thread`,
      { method: "GET" }
    )) as BridgeThreadResponse
  } catch (error) {
    if (error instanceof CodexConversationError && error.status === 404) throw error
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
    mappingState?: string
    replacementOfThreadId?: string
    nativeName?: string
    nativeCursor?: string
    lastSyncAt?: string
    syncWarning?: string
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
    mappingState: session.mappingState,
    replacementOfThreadId: session.replacementOfThreadId,
    nativeName: session.nativeName,
    nativeCursor: session.nativeCursor,
    lastSyncAt: session.lastSyncAt,
    syncWarning: session.mappingState === "replacement_pending"
      ? "Native Codex thread unavailable; the next Codex message will create a replacement."
      : session.replacementOfThreadId
        ? `Native Codex thread replaced: ${session.replacementOfThreadId}`
        : session.syncWarning,
    finalText: bridgeState?.finalText,
    liveText: bridgeState?.liveText
  }
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}

function latestNativeTurnId(turns: NativeTurn[]) {
  return turns.at(-1)?.id
}

async function recordHarnessTurnStart(
  repository: HiveMemoryRepository,
  conversationId: string,
  session: { codexThreadId: string },
  userEntry: ConversationEntry,
  turnResult: unknown,
  requestContent: string
) {
  const turnId = (turnResult as { turn?: { id?: unknown } } | undefined)?.turn?.id
  if (typeof turnId !== "string" || !turnId) return
  await repository.recordCodexSyncItem({
    conversationId,
    nativeThreadId: session.codexThreadId,
    nativeTurnId: turnId,
    nativeItemId: `harness-user:${turnId}`,
    source: "harness",
    kind: "userMessage",
    conversationEntryId: userEntry.id,
    contentHash: requestContent
  })
}

function codexThreadName(repository: HiveMemoryRepository, conversationId: string) {
  const title = repository.getConversationMetadata(conversationId)?.title?.trim()
  return title ? `Harness · ${title}` : undefined
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds)
  })
}

function toConversationScopedIdempotencyKey(
  conversationId: string,
  idempotencyKey: string
) {
  return `${conversationId}:${idempotencyKey.trim()}`
}

export class CodexConversationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}
