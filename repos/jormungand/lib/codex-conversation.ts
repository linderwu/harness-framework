import { projectNativeThread, type NativeTurn } from "./codex-thread-sync"
import type { ConversationLifecyclePort } from "./conversation-lifecycle/types"
import type { HiveMemoryRepository } from "./hive-memory/repository"
import type { ConversationEntry } from "./hive-memory/types"

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
  lifecycle?: ConversationLifecyclePort,
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
        return getCodexConversationState(repository, conversationId, lifecycle, true)
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

  let bridgeThread: BridgeThreadResponse | undefined
  let replacementPending = false
  try {
    bridgeThread = await readBridgeThread(session.bridgeSessionId)
  } catch (error) {
    if (error instanceof CodexConversationError && error.status === 404) {
      replacementPending = true
      await repository.updateCodexSession({
        conversationId,
        bridgeSessionId: session.bridgeSessionId,
        status: "offline",
        mappingState: "replacement_pending"
      })
    }
  }
  if (!replacementPending) {
    await syncConversation(repository, lifecycle, conversationId, bridgeState, session.bridgeSessionId)
  }
  if (bridgeThread?.thread?.turns) {
    if (lifecycle) {
      await syncNativeThread(repository, lifecycle, conversationId, bridgeThread.thread)
    }
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
  lifecycle: ConversationLifecyclePort | undefined,
  conversationId: string,
  bridgeState: BridgeEventsResponse,
  bridgeSessionId: string
) {
  const entries = repository.listConversation(conversationId)
  const responseEntry = [...entries].reverse().find(
    (entry) =>
      (entry.role === "agent" || entry.role === "manager") &&
      entry.status === "running"
  )
  const activityText = [...bridgeState.events]
    .reverse()
    .find((event) => event.message?.trim())?.message
  const isCompleted =
    bridgeState.status === "idle" && bridgeState.turnStatus === "completed"
  const isFailed =
    bridgeState.status === "failed" || bridgeState.turnStatus === "failed"
  const isPaused =
    bridgeState.status === "paused" || bridgeState.turnStatus === "interrupted"
  const isStopped =
    bridgeState.status === "stopped" || bridgeState.turnStatus === "stopped"
  const activeTurn = findActiveLifecycleCodexTurnForResponse(
    repository,
    conversationId,
    entries,
    responseEntry
  )
  if (lifecycle && activeTurn) {
    const body = bridgeState.finalText || bridgeState.liveText ||
      (isPaused
        ? "Codex paused. Choose Continue to resume this session."
        : isFailed
          ? activityText || "Codex failed to complete this turn."
          : activityText || "Codex is working...")
    if (isCompleted || isFailed || isStopped) {
      await lifecycle.settleTurn({
        conversationId,
        userEntryId: activeTurn.userEntry.id,
        responseEntryId: activeTurn.responseEntry.id,
        jobId: activeTurn.job.id,
        idempotencyKey: activeTurn.job.idempotencyKey,
        leaseOwner: activeTurn.job.leaseOwner!,
        outcome: isCompleted
          ? { kind: "completed", body, deliveryState: "confirmed" }
          : isStopped
            ? { kind: "interrupted", body, deliveryState: "confirmed", disposition: "stopped" }
            : { kind: "failed", body, deliveryState: "confirmed" }
      })
    } else if (!isPaused) {
      await lifecycle.recordTurnProgress({
        conversationId,
        userEntryId: activeTurn.userEntry.id,
        responseEntryId: activeTurn.responseEntry.id,
        body
      })
    }
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

function findActiveLifecycleCodexTurn(
  repository: HiveMemoryRepository,
  conversationId: string,
  userEntry: ConversationEntry | undefined,
  responseEntry: ConversationEntry | undefined
): { userEntry: ConversationEntry; responseEntry: ConversationEntry; job: NonNullable<ReturnType<HiveMemoryRepository["getExecutionJobByIdempotencyKey"]>> } | undefined {
  if (
    !userEntry ||
    !responseEntry ||
    userEntry.workflowRunId !== conversationId ||
    responseEntry.workflowRunId !== conversationId ||
    userEntry.role !== "user" ||
    (responseEntry.role !== "agent" && responseEntry.role !== "manager") ||
    userEntry.agentId !== "codex" ||
    responseEntry.agentId !== "codex" ||
    responseEntry.replyToId !== userEntry.id ||
    responseEntry.idempotencyKey !== `${userEntry.idempotencyKey}:response`
  ) {
    return undefined
  }

  const job = repository.getExecutionJobByIdempotencyKey(`${userEntry.idempotencyKey}:dispatch`)
  if (
    !job ||
    job.kind !== "conversation_dispatch" ||
    job.workflowRunId !== conversationId ||
    job.status !== "running" ||
    !job.leaseOwner ||
    !job.leaseExpiresAt ||
    job.leaseExpiresAt <= new Date().toISOString()
  ) {
    return undefined
  }

  try {
    const payload = JSON.parse(job.payloadJson) as Record<string, unknown>
    if (payload.conversationId === conversationId &&
      payload.entryId === userEntry.id &&
      payload.responseEntryId === responseEntry.id &&
      payload.targetAgent === "codex") {
      return { userEntry, responseEntry, job }
    }
    return undefined
  } catch {
    return undefined
  }
}

function findActiveLifecycleCodexTurnForResponse(
  repository: HiveMemoryRepository,
  conversationId: string,
  entries: ConversationEntry[],
  responseEntry: ConversationEntry | undefined
) {
  const userEntry = responseEntry
    ? entries.find((entry) => entry.id === responseEntry.replyToId)
    : undefined
  return findActiveLifecycleCodexTurn(repository, conversationId, userEntry, responseEntry)
}

async function syncNativeThread(
  repository: HiveMemoryRepository,
  lifecycle: ConversationLifecyclePort,
  conversationId: string,
  thread: NonNullable<BridgeThreadResponse["thread"]>
) {
  const ledgerItems = repository.listCodexSyncItems(conversationId)
  const harnessTurnIds = new Set(
    ledgerItems
      .filter((item) => item.source === "harness" && item.nativeThreadId === thread.id)
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
      .filter((item) => item.kind === "userMessage" && item.conversationEntryId)
      .map((item) => [
        `${item.nativeThreadId}:${item.nativeTurnId}`,
        item.conversationEntryId!
      ] as const)
  )

  for (const projected of projection.entries) {
    if (projected.source === "harness") continue
    let conversationEntryId: string
    const replyToId = projected.replyToNativeTurnId
      ? nativeUserEntries.get(
        `${projected.nativeThreadId}:${projected.replyToNativeTurnId}`
      )
      : undefined

    if (projected.role === "user") {
      const entry = await lifecycle.reconcileProviderEntry({
        conversationId,
        role: "user",
        content: projected.content,
        status: projected.status,
        idempotencyKey: projected.idempotencyKey
      })
      conversationEntryId = entry.id
      nativeUserEntries.set(
        `${projected.nativeThreadId}:${projected.nativeTurnId}`,
        conversationEntryId
      )
    } else {
      const conversationEntries = repository.listConversation(conversationId)
      const fallbackReplyToId = [...conversationEntries]
        .reverse()
        .find((entry) => entry.role === "user")?.id
      const responseReplyToId = replyToId ?? fallbackReplyToId
      const responseCandidates = responseReplyToId
        ? [...conversationEntries]
          .reverse()
          .filter((entry) =>
            (entry.role === "agent" || entry.role === "manager") &&
            entry.replyToId === responseReplyToId &&
            entry.agentId === "codex"
          )
        : []
      const activeLifecycleTurn = responseCandidates
        .map((entry) => findActiveLifecycleCodexTurnForResponse(
          repository,
          conversationId,
          conversationEntries,
          entry
        ))
        .find((turn) => turn !== undefined)
      if (activeLifecycleTurn) continue

      const existingResponse = responseCandidates.find((entry) =>
        entry.role === "agent" &&
        (entry.status === "queued" || entry.status === "running")
      )
      if (existingResponse) {
        const entry = await lifecycle.reconcileProviderEntry({
          conversationId,
          role: "agent",
          content: projected.content,
          status: projected.status,
          idempotencyKey: projected.idempotencyKey,
          replyToId: responseReplyToId,
          replaceEntryId: existingResponse.id
        })
        conversationEntryId = entry.id
      } else {
        const entry = await lifecycle.reconcileProviderEntry({
          conversationId,
          role: "agent",
          content: projected.content,
          status: projected.status,
          replyToId: responseReplyToId,
          idempotencyKey: projected.idempotencyKey
        })
        conversationEntryId = entry.id
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

  await coalesceNativeAgentDuplicates(repository, lifecycle, conversationId, thread)
}

async function coalesceNativeAgentDuplicates(
  repository: HiveMemoryRepository,
  lifecycle: ConversationLifecyclePort,
  conversationId: string,
  thread: NonNullable<BridgeThreadResponse["thread"]>
) {
  const entries = repository.listConversation(conversationId)
  const ledgerItems = repository.listCodexSyncItems(conversationId)

  for (const turn of thread.turns ?? []) {
    const nativeAgentLedger = ledgerItems.filter((item) =>
      item.nativeThreadId === thread.id &&
      item.nativeTurnId === turn.id &&
      item.kind === "agentMessage" &&
      item.conversationEntryId
    )
    if (nativeAgentLedger.length < 1) continue

    const nativeEntryIds = new Set(nativeAgentLedger.map((item) => item.conversationEntryId!))
    const replyToIds = new Set(
      entries
        .filter((entry) => nativeEntryIds.has(entry.id))
        .map((entry) => entry.replyToId)
        .filter((id): id is string => Boolean(id))
    )
    const nativeContent = new Set(nativeAgentLedger.map((item) => normalizeContent(item.contentHash ?? "")))
    const candidates = entries.filter((entry) =>
      entry.role === "agent" &&
      entry.agentId === "codex" &&
      (
        nativeEntryIds.has(entry.id) ||
        (entry.replyToId !== undefined && replyToIds.has(entry.replyToId))
      ) &&
      nativeContent.has(normalizeContent(entry.content))
    )
    const byContent = new Map<string, ConversationEntry[]>()
    for (const entry of candidates) {
      const key = normalizeContent(entry.content)
      const group = byContent.get(key) ?? []
      group.push(entry)
      byContent.set(key, group)
    }

    for (const group of byContent.values()) {
      if (group.length < 2) continue
      const preferred = group.find((entry) => entry.idempotencyKey.endsWith(":response")) ?? group[0]
      for (const duplicate of group) {
        if (duplicate.id !== preferred.id) {
          await lifecycle.coalesceProviderEntries({
            preferredId: preferred.id,
            duplicateId: duplicate.id
          })
        }
      }
    }
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

function normalizeContent(value: string) {
  return value.trim().replace(/\s+/g, " ")
}

function codexThreadName(repository: HiveMemoryRepository, conversationId: string) {
  const title = repository.getConversationMetadata(conversationId)?.title?.trim()
  return title ? `Harness · ${title}` : undefined
}

export class CodexConversationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}
