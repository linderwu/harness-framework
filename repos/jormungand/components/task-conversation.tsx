"use client"

import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Send } from "lucide-react"
import type { AgentLiveEvent } from "@/lib/agent-live-events"
import { MAX_AGENT_LIVE_TEXT, normalizeAgentLiveEvent } from "@/lib/agent-live-events"
import type {
  CodexConversationEvent,
  CodexConversationState
} from "@/lib/codex-conversation"
import { getAgentLabel } from "@/lib/agents"
import type { ConversationBinding } from "@/lib/conversation"
import type {
  ConversationEntry,
  ConversationMetadata,
  ConversationState,
  ConversationSummary
} from "@/lib/hive-memory/types"
import type { AgentKind, WorkflowRun } from "@/lib/types"

type ConversationHeaderMetadata = Pick<
  ConversationMetadata,
  "conversationId" | "title" | "state"
>

type ConversationPermissionMode = "full" | "restricted"

type ConversationLoadResult = Partial<CodexConversationState> & {
  entries: ConversationEntry[]
  allowedAgents: AgentKind[]
  error?: string
  metadata?: ConversationHeaderMetadata
  permissionMode?: ConversationPermissionMode
}

type NewConversationResult = {
  conversationId: string
  metadata?: ConversationHeaderMetadata
}

type ConversationManagerAction = "rename" | "archive" | "unarchive" | "delete"
type AgentLivePreview = {
  events: AgentLiveEvent[]
  reasoning?: string
  status?: string
}
type AgentLiveSubmissionLifecycle = {
  postPending: boolean
  terminalEventReceived: boolean
}
type AgentLivePanelState = {
  visible: boolean
  agentId?: AgentKind
}

export const MAX_VISIBLE_AGENT_LIVE_EVENTS = 18

export function buildConversationLivePath(conversationId: string) {
  return `/api/conversation/live?conversationId=${encodeURIComponent(conversationId)}`
}

export function shouldOpenAgentLiveStream(agentId: AgentKind) {
  return agentId !== "codex"
}

export function isAgentLiveTerminal(event: AgentLiveEvent) {
  return event.type === "completed" || event.type === "failed"
}

export function reduceAgentLivePreview(current: AgentLivePreview, event: AgentLiveEvent): AgentLivePreview {
  const nextStatus = event.type === "assistant_delta" || event.type === "reasoning"
    ? current.status
    : readAgentLiveMessage(event) ?? current.status
  const nextReasoning = event.type === "reasoning"
    ? readAgentLiveMessage(event)?.slice(0, MAX_AGENT_LIVE_TEXT) ?? current.reasoning
    : current.reasoning
  const nextEvents = event.type === "reasoning"
    ? current.events
    : [...current.events, event].slice(-MAX_VISIBLE_AGENT_LIVE_EVENTS)

  return {
    events: nextEvents,
    reasoning: nextReasoning,
    status: nextStatus?.slice(0, MAX_AGENT_LIVE_TEXT)
  }
}

export function startAgentLiveSubmissionLifecycle(): AgentLiveSubmissionLifecycle {
  return {
    postPending: true,
    terminalEventReceived: false
  }
}

export function advanceAgentLiveSubmissionLifecycle(
  lifecycle: AgentLiveSubmissionLifecycle | undefined,
  event: AgentLiveEvent
) {
  const terminal = isAgentLiveTerminal(event)

  if (!lifecycle) {
    return {
      lifecycle: undefined,
      shouldCloseSource: terminal
    }
  }

  if (terminal && lifecycle.postPending) {
    return {
      lifecycle: {
        ...lifecycle,
        terminalEventReceived: true
      },
      shouldCloseSource: false
    }
  }

  return {
    lifecycle: terminal ? undefined : lifecycle,
    shouldCloseSource: terminal
  }
}

export function settleAgentLiveSubmissionLifecycle(
  lifecycle: AgentLiveSubmissionLifecycle | undefined
) {
  if (!lifecycle) {
    return {
      lifecycle: undefined,
      shouldCloseSource: false
    }
  }

  if (lifecycle.terminalEventReceived) {
    return {
      lifecycle: undefined,
      shouldCloseSource: true
    }
  }

  return {
    lifecycle: {
      ...lifecycle,
      postPending: false
    },
    shouldCloseSource: false
  }
}

export function shouldIgnoreAgentLiveSourceError(
  lifecycle: AgentLiveSubmissionLifecycle | undefined
) {
  return !!lifecycle?.postPending && lifecycle.terminalEventReceived
}

export function getAgentLivePanelState(input: {
  targetAgent: AgentKind
  liveSourceAgentId?: AgentKind
  liveEventAgentId?: AgentKind
  hasActiveSource: boolean
  hasActiveSubmission: boolean
  status?: string
  reasoning?: string
  eventCount: number
}): AgentLivePanelState {
  const agentId = input.liveEventAgentId
    ?? input.liveSourceAgentId
    ?? (shouldOpenAgentLiveStream(input.targetAgent) ? input.targetAgent : undefined)
  const visible = !!agentId && (input.hasActiveSource || input.hasActiveSubmission)

  return {
    visible,
    agentId
  }
}

export function TaskConversation(props: {
  run?: WorkflowRun
  initialEntries: ConversationEntry[]
  allowedAgents: AgentKind[]
  onEntriesChanged: (entries: ConversationEntry[]) => void
  onBound?: (binding: ConversationBinding) => void
  onNewConversation?: () => void
}) {
  const runId = props.run?.id
  const isUnbound = !runId
  const conversationPath = runId ? `/api/workflow-runs/${runId}/conversation` : "/api/conversation"
  const onEntriesChanged = props.onEntriesChanged
  const [entries, setEntries] = useState(props.initialEntries)
  const initialAllowedAgents = props.allowedAgents
  const [allowedAgents, setAllowedAgents] = useState(initialAllowedAgents)
  const [targetAgent, setTargetAgent] = useState<AgentKind>(initialAllowedAgents[0] ?? "codex")
  const [conversationId, setConversationId] = useState<string | undefined>(runId)
  const [content, setContent] = useState("")
  const [error, setError] = useState<string>()
  const [statusMessage, setStatusMessage] = useState<string>()
  const [session, setSession] = useState<CodexConversationState["session"]>()
  const [events, setEvents] = useState<CodexConversationEvent[]>([])
  const [agentLiveEvents, setAgentLiveEvents] = useState<AgentLiveEvent[]>([])
  const [agentLiveReasoning, setAgentLiveReasoning] = useState<string | undefined>()
  const [agentLiveStatus, setAgentLiveStatus] = useState<string | undefined>()
  const [activeEventSource, setActiveEventSource] = useState<EventSource | undefined>()
  const [activeAgentLiveSourceAgentId, setActiveAgentLiveSourceAgentId] = useState<AgentKind | undefined>()
  const [isControlling, setIsControlling] = useState(false)
  const [isLoadingConversation, setIsLoadingConversation] = useState(true)
  const [isStartingConversation, setIsStartingConversation] = useState(false)
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [metadata, setMetadata] = useState<ConversationHeaderMetadata>()
  const [permissionMode, setPermissionMode] = useState<ConversationPermissionMode>()
  const [includeArchived, setIncludeArchived] = useState(false)
  const [isRenameFormOpen, setIsRenameFormOpen] = useState(false)
  const [renameDraft, setRenameDraft] = useState("")
  const [activeManagerAction, setActiveManagerAction] = useState<ConversationManagerAction | undefined>()
  const [isConversationIdentityUnavailable, setIsConversationIdentityUnavailable] = useState(false)
  const [isReplacingDeletedConversation, setIsReplacingDeletedConversation] = useState(false)
  const [isDeleteDialogFallbackOpen, setIsDeleteDialogFallbackOpen] = useState(false)
  const requestGeneration = useRef(0)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const renameDialogRef = useRef<HTMLDialogElement>(null)
  const renameTriggerRef = useRef<HTMLButtonElement>(null)
  const deleteDialogRef = useRef<HTMLDialogElement>(null)
  const deleteTriggerRef = useRef<HTMLButtonElement>(null)
  const deleteCancelRef = useRef<HTMLButtonElement>(null)
  const isRenameFormOpenRef = useRef(false)
  const activeEventSourceRef = useRef<EventSource | undefined>(undefined)
  const agentLiveEventListenerRef = useRef<EventListener | undefined>(undefined)
  const agentLiveErrorListenerRef = useRef<EventListener | undefined>(undefined)
  const agentLivePreviewRef = useRef<AgentLivePreview>({ events: [] })
  const agentLiveSubmissionLifecycleRef = useRef<{ postPending: boolean; terminalEventReceived: boolean } | undefined>(undefined)
  const pollingInFlight = useRef<{
    generation: number
    promise: ReturnType<typeof loadConversation>
  } | undefined>(undefined)
  const pending = useMemo(() => entries.some((entry) => entry.status === "queued" || entry.status === "running"), [entries])
  const activeConversationId = isUnbound ? conversationId : runId
  const conversationLoadPath = isUnbound && activeConversationId
    ? `${conversationPath}?conversationId=${encodeURIComponent(activeConversationId)}`
    : conversationPath
  const currentConversationSummary = useMemo(() => {
    if (!isUnbound || !activeConversationId) return undefined
    const listed = conversations.find((conversation) => conversation.conversationId === activeConversationId)
    if (listed) return listed
    if (!metadata || metadata.conversationId !== activeConversationId) return undefined
    const latestEntry = entries.at(-1)
    return {
      conversationId: activeConversationId,
      title: metadata.title,
      state: metadata.state,
      messageCount: entries.length,
      latestMessage: latestEntry?.content,
      latestMessageAt: latestEntry?.createdAt
    } satisfies ConversationSummary
  }, [activeConversationId, conversations, entries, isUnbound, metadata])
  const conversationOptions = useMemo(() => {
    if (!isUnbound) return []
    if (!currentConversationSummary) return conversations
    const found = conversations.some(
      (conversation) => conversation.conversationId === currentConversationSummary.conversationId
    )
    return found ? conversations : [...conversations, currentConversationSummary]
  }, [conversations, currentConversationSummary, isUnbound])
  const currentConversationTitle = props.run?.projectName
    ?? metadata?.title
    ?? currentConversationSummary?.title
    ?? (isUnbound ? (isLoadingConversation ? "Loading conversation" : "New conversation") : "Conversation")

  function resetAgentLivePreview() {
    agentLivePreviewRef.current = { events: [] }
    setAgentLiveEvents([])
    setAgentLiveReasoning(undefined)
    setAgentLiveStatus(undefined)
  }

  function closeAgentLiveSource(options?: { preservePreview?: boolean }) {
    const source = activeEventSourceRef.current
    const handleAgentLiveEvent = agentLiveEventListenerRef.current
    const handleAgentLiveError = agentLiveErrorListenerRef.current

    if (source && handleAgentLiveEvent) {
      source.removeEventListener("agent-live", handleAgentLiveEvent)
    }
    if (source && handleAgentLiveError) {
      source.removeEventListener("error", handleAgentLiveError)
    }
    if (source) {
      source.close()
    }

    activeEventSourceRef.current = undefined
    agentLiveSubmissionLifecycleRef.current = undefined
    agentLiveEventListenerRef.current = undefined
    agentLiveErrorListenerRef.current = undefined
    setActiveEventSource(undefined)
    setActiveAgentLiveSourceAgentId(undefined)

    if (!options?.preservePreview) {
      resetAgentLivePreview()
    }
  }

  function invalidateConversationRequests() {
    closeAgentLiveSource()
    requestGeneration.current += 1
    pollingInFlight.current = undefined
  }

  function loadConversationWithGuard(path: string, requireConversationId: boolean) {
    const inFlight = pollingInFlight.current
    if (inFlight) return inFlight

    const request = {
      generation: requestGeneration.current,
      promise: loadConversation(path, requireConversationId)
    }
    pollingInFlight.current = request
    request.promise.then(
      () => {
        if (pollingInFlight.current === request) pollingInFlight.current = undefined
      },
      () => {
        if (pollingInFlight.current === request) pollingInFlight.current = undefined
      }
    )
    return request
  }

  const refreshConversations = useCallback(async (generation = requestGeneration.current) => {
    try {
      const nextConversations = await requestConversationSummaries(fetch, includeArchived)
      if (generation !== requestGeneration.current) return
      setConversations(nextConversations)
    } catch (conversationListError) {
      if (generation !== requestGeneration.current) return
      setError(formatError(conversationListError))
    }
  }, [includeArchived])

  useEffect(() => {
    isRenameFormOpenRef.current = isRenameFormOpen
  }, [isRenameFormOpen])

  useEffect(() => {
    if (!isRenameFormOpen) return
    renameInputRef.current?.focus()
    renameInputRef.current?.select()
  }, [isRenameFormOpen])

  useEffect(() => {
    if (!isDeleteDialogFallbackOpen) return
    queueDeleteDialogFocus()
  }, [isDeleteDialogFallbackOpen])

  useEffect(() => {
    if (activeEventSource) {
      activeEventSourceRef.current = activeEventSource
    }
  }, [activeEventSource])

  useEffect(() => {
    if (shouldSkipUnboundHydration({
      activeConversationId,
      isConversationIdentityUnavailable,
      isReplacingDeletedConversation,
      isUnbound
    })) return
    let active = true
    // This effect owns the request lifecycle for active-conversation hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoadingConversation(true)
    const request = loadConversationWithGuard(conversationLoadPath, isUnbound)
    const { generation } = request
    void request.promise.then((data) => {
      if (!active || generation !== requestGeneration.current) return
      setConversationId(data.conversationId ?? runId)
      setEntries(data.entries)
      setAllowedAgents(data.allowedAgents)
      setTargetAgent((current) => data.allowedAgents.includes(current) ? current : data.allowedAgents[0] ?? "codex")
      setSession(data.session)
      setEvents(data.events ?? [])
      setMetadata(data.metadata)
      setPermissionMode(data.permissionMode)
      if (!isRenameFormOpenRef.current) {
        setRenameDraft(data.metadata?.title ?? "")
      }
      onEntriesChanged(data.entries)
    }).catch((loadError) => {
      if (!active || generation !== requestGeneration.current) return
      setError(formatError(loadError))
    }).finally(() => {
      if (!active || generation !== requestGeneration.current) return
      setIsLoadingConversation(false)
    })
    return () => {
      active = false
      invalidateConversationRequests()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeConversationId, conversationLoadPath, isConversationIdentityUnavailable, isReplacingDeletedConversation, isUnbound, onEntriesChanged, runId])

  useEffect(() => {
    if (!pending) return
    let active = true
    const timer = window.setInterval(() => {
      if (pollingInFlight.current) return
      const request = loadConversationWithGuard(conversationLoadPath, isUnbound)
      const { generation } = request
      void request.promise.then((data) => {
        if (!active || generation !== requestGeneration.current) return
        setConversationId(data.conversationId ?? runId)
        setEntries(data.entries)
        setSession(data.session)
        setEvents(data.events ?? [])
        setMetadata(data.metadata)
        setPermissionMode(data.permissionMode)
        onEntriesChanged(data.entries)
      }).catch((loadError) => {
        if (!active || generation !== requestGeneration.current) return
        setError(formatError(loadError))
      })
    }, isUnbound ? 1_200 : 3_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [conversationLoadPath, isUnbound, onEntriesChanged, pending, runId])

  useEffect(() => {
    if (!isUnbound) return
    if (isStartingConversation && !activeConversationId) return
    // This effect refreshes managed conversation summaries after identity/filter changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshConversations()
  }, [activeConversationId, isStartingConversation, isUnbound, refreshConversations])

  useEffect(() => () => {
    closeAgentLiveSource()
    invalidateConversationRequests()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    const message = content.trim()
    if (!message || allowedAgents.length === 0 || !activeConversationId || isLoadingConversation || isStartingConversation) return
    if (activeManagerAction) return
    const generation = requestGeneration.current
    let idempotencyKey: string
    try {
      idempotencyKey = crypto.randomUUID()
    } catch {
      idempotencyKey = `conversation-${Date.now()}-${Math.random().toString(36).slice(2)}`
    }
    const optimistic: ConversationEntry = {
      id: `optimistic:${idempotencyKey}`,
      workflowRunId: activeConversationId,
      role: "user",
      agentId: targetAgent,
      content: message,
      importance: "normal",
      status: "queued",
      artifactIds: [],
      memoryIds: [],
      idempotencyKey,
      createdAt: new Date().toISOString()
    }
    setEntries((current) => [...current, optimistic])
    setContent("")
    setError(undefined)
    setStatusMessage(undefined)
    try {
      if (shouldOpenAgentLiveStream(targetAgent)) {
        closeAgentLiveSource()
        agentLiveSubmissionLifecycleRef.current = startAgentLiveSubmissionLifecycle()
        if (typeof window !== "undefined" && typeof EventSource === "function") {
          try {
            const source = new EventSource(buildConversationLivePath(activeConversationId))
            setActiveAgentLiveSourceAgentId(targetAgent)
            const handleAgentLiveEvent: EventListener = (rawEvent) => {
              const nextGeneration = requestGeneration.current
              if (generation !== nextGeneration) {
                closeAgentLiveSource()
                return
              }

              try {
                const messageEvent = rawEvent as MessageEvent<string>
                const event = normalizeAgentLiveEvent(JSON.parse(messageEvent.data))
                const nextPreview = reduceAgentLivePreview(agentLivePreviewRef.current, event)
                agentLivePreviewRef.current = nextPreview
                setAgentLiveEvents(nextPreview.events)
                setAgentLiveReasoning(nextPreview.reasoning)
                setAgentLiveStatus(nextPreview.status)
                const lifecycleResult = advanceAgentLiveSubmissionLifecycle(agentLiveSubmissionLifecycleRef.current, event)
                agentLiveSubmissionLifecycleRef.current = lifecycleResult.lifecycle
                if (lifecycleResult.shouldCloseSource) {
                  closeAgentLiveSource()
                }
              } catch {
                // Ignore malformed or non-agent-live frames so final POST still succeeds.
              }
            }
            const handleAgentLiveError: EventListener = () => {
              if (shouldIgnoreAgentLiveSourceError(agentLiveSubmissionLifecycleRef.current)) {
                return
              }
              closeAgentLiveSource()
            }

            agentLiveEventListenerRef.current = handleAgentLiveEvent
            agentLiveErrorListenerRef.current = handleAgentLiveError
            source.addEventListener("agent-live", handleAgentLiveEvent)
            source.addEventListener("error", handleAgentLiveError)
            activeEventSourceRef.current = source
            setActiveEventSource(source)
          } catch {
            // Silent fallback when EventSource construction is unavailable.
          }
        }
      }
      const response = await fetch(conversationPath, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ conversationId: activeConversationId, targetAgent, content: message, idempotencyKey })
      })
      const result = await response.json() as {
        conversationId?: string
        error?: string
        userEntry?: ConversationEntry
        responseEntry?: ConversationEntry
        binding?: ConversationBinding
        entries?: ConversationEntry[]
        session?: CodexConversationState["session"]
        events?: CodexConversationEvent[]
      }
      if (!response.ok || !result.userEntry) throw new Error(result.error ?? "Message dispatch failed")
      if (generation !== requestGeneration.current) return
      const lifecycleResult = settleAgentLiveSubmissionLifecycle(agentLiveSubmissionLifecycleRef.current)
      agentLiveSubmissionLifecycleRef.current = lifecycleResult.lifecycle
      if (lifecycleResult.shouldCloseSource) {
        closeAgentLiveSource()
      }
      setConversationId(result.conversationId ?? activeConversationId)
      setEntries((current) => result.entries ?? mergeResult(current, optimistic.id, result.userEntry!, result.responseEntry))
      setSession(result.session)
      setEvents(result.events ?? [])
      if (isUnbound) void refreshConversations(generation)
      if (result.binding) props.onBound?.(result.binding)
    } catch (submitError) {
      if (generation !== requestGeneration.current) return
      closeAgentLiveSource()
      setEntries((current) => current.map((entry) => entry.id === optimistic.id ? { ...entry, status: "failed" } : entry))
      setError(formatError(submitError))
    }
  }

  async function control(action: "interrupt" | "resume" | "stop") {
    if (!activeConversationId || isLoadingConversation || isStartingConversation) return
    const generation = requestGeneration.current
    setIsControlling(true)
    setError(undefined)
    setStatusMessage(undefined)
    try {
      const response = await fetch("/api/conversation/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, conversationId: activeConversationId })
      })
      const result = await response.json() as CodexConversationState & { error?: string }
      if (!response.ok) throw new Error(result.error ?? "Codex control request failed")
      if (generation !== requestGeneration.current) return
      setConversationId(result.conversationId ?? activeConversationId)
      setEntries(result.entries)
      setSession(result.session)
      setEvents(result.events ?? [])
      onEntriesChanged(result.entries)
    } catch (controlError) {
      if (generation !== requestGeneration.current) return
      setError(formatError(controlError))
    } finally {
      setIsControlling(false)
    }
  }

  async function startNewConversation() {
    if (isConversationManagerLocked({
      isLoadingConversation,
      isStartingConversation,
      isConversationIdentityUnavailable,
      isReplacingDeletedConversation,
      isControlling,
      isTurnRunning: isUnbound && session?.turnStatus === "inProgress",
      activeManagerAction
    })) return

    invalidateConversationRequests()
    setIsStartingConversation(true)
    setError(undefined)
    setStatusMessage(undefined)
    try {
      const result = await requestNewConversation(fetch)
      setConversationId(result.conversationId)
      setEntries([])
      setAllowedAgents(initialAllowedAgents)
      setTargetAgent((current) => initialAllowedAgents.includes(current) ? current : initialAllowedAgents[0] ?? "codex")
      setContent("")
      setMetadata(result.metadata)
      setSession(undefined)
      setEvents([])
      setIsConversationIdentityUnavailable(false)
      setIsLoadingConversation(true)
      setIsReplacingDeletedConversation(false)
      setIsRenameFormOpen(false)
      setRenameDraft(result.metadata?.title ?? "")
      onEntriesChanged([])
      props.onNewConversation?.()
      setStatusMessage(`Started ${result.metadata?.title ?? "a new conversation"}.`)
    } catch (startError) {
      if (!activeConversationId) {
        setIsConversationIdentityUnavailable(true)
        setIsLoadingConversation(false)
      }
      setError(formatError(startError))
    } finally {
      setIsStartingConversation(false)
    }
  }

  function handleConversationSwitch(nextConversationId: string) {
    if (!nextConversationId || nextConversationId === activeConversationId) return
    invalidateConversationRequests()
    const nextState = buildConversationSwitchState(nextConversationId)
    setConversationId(nextState.conversationId)
    setContent(nextState.content)
    setEntries(nextState.entries)
    setError(nextState.error)
    setEvents(nextState.events)
    setIsLoadingConversation(nextState.isLoadingConversation)
    setMetadata(undefined)
    setSession(nextState.session)
    setStatusMessage(nextState.statusMessage)
    setIsRenameFormOpen(false)
    setRenameDraft("")
    onEntriesChanged([])
  }

  function queueRenameDialogFocus() {
    if (typeof window === "undefined") return
    window.requestAnimationFrame(() => {
      renameInputRef.current?.focus()
      renameInputRef.current?.select()
    })
  }

  function closeRenameDialog() {
    setIsRenameFormOpen(false)
    const dialog = renameDialogRef.current
    if (dialog?.open && dialog.close) {
      dialog.close()
    }
    if (typeof window === "undefined") return
    window.requestAnimationFrame(() => {
      renameTriggerRef.current?.focus()
    })
  }

  function openRenameDialog() {
    setError(undefined)
    setStatusMessage(undefined)
    setRenameDraft(metadata?.title ?? currentConversationTitle)
    setIsRenameFormOpen(true)
    const dialog = renameDialogRef.current
    if (dialog?.showModal) {
      if (!dialog.open) {
        dialog.showModal()
      }
      queueRenameDialogFocus()
    }
  }

  function closeRenameForm() {
    closeRenameDialog()
    setRenameDraft(metadata?.title ?? "")
  }

  async function handleRenameSubmit(event: FormEvent) {
    event.preventDefault()
    if (!activeConversationId || !isUnbound) return
    const generation = requestGeneration.current
    setActiveManagerAction("rename")
    setError(undefined)
    setStatusMessage(undefined)
    try {
      const summary = await requestConversationRename(fetch, activeConversationId, renameDraft)
      if (generation !== requestGeneration.current) return
      setMetadata(toConversationHeaderMetadata(summary))
      setRenameDraft(summary.title)
      closeRenameDialog()
      setStatusMessage(`Renamed to ${summary.title}.`)
      void refreshConversations(generation)
    } catch (renameError) {
      if (generation !== requestGeneration.current) return
      setError(formatError(renameError))
    } finally {
      setActiveManagerAction(undefined)
    }
  }

  async function handleConversationStateChange(nextState: ConversationState) {
    if (!activeConversationId || !isUnbound) return
    const generation = requestGeneration.current
    setActiveManagerAction(nextState === "archived" ? "archive" : "unarchive")
    setError(undefined)
    setStatusMessage(undefined)
    try {
      const summary = await requestConversationState(fetch, activeConversationId, nextState)
      if (generation !== requestGeneration.current) return
      setMetadata(toConversationHeaderMetadata(summary))
      setStatusMessage(
        nextState === "archived"
          ? "Conversation archived."
          : "Conversation restored."
      )
      void refreshConversations(generation)
    } catch (stateError) {
      if (generation !== requestGeneration.current) return
      setError(formatError(stateError))
    } finally {
      setActiveManagerAction(undefined)
    }
  }

  function queueDeleteDialogFocus() {
    if (typeof window === "undefined") return
    window.requestAnimationFrame(() => {
      deleteCancelRef.current?.focus()
    })
  }

  function closeDeleteDialog() {
    setIsDeleteDialogFallbackOpen(false)
    const dialog = deleteDialogRef.current
    if (dialog?.open && dialog.close) {
      dialog.close()
    }
    if (typeof window === "undefined") return
    window.requestAnimationFrame(() => {
      deleteTriggerRef.current?.focus()
    })
  }

  function openDeleteDialog() {
    setError(undefined)
    setStatusMessage(undefined)
    const dialog = deleteDialogRef.current
    if (dialog?.showModal) {
      if (!dialog.open) {
        dialog.showModal()
      }
      queueDeleteDialogFocus()
      return
    }
    setIsDeleteDialogFallbackOpen(true)
  }

  async function handleDeleteConversation() {
    if (!activeConversationId || !isUnbound) return
    const currentId = activeConversationId
    setActiveManagerAction("delete")
    setError(undefined)
    setStatusMessage(undefined)
    try {
      await requestConversationDeletion(fetch, currentId)
      closeDeleteDialog()
      invalidateConversationRequests()
      const deletedState = buildDeletedConversationState()
      setIsConversationIdentityUnavailable(false)
      setIsReplacingDeletedConversation(true)
      setConversationId(deletedState.conversationId)
      setContent(deletedState.content)
      setEntries(deletedState.entries)
      setError(deletedState.error)
      setEvents(deletedState.events)
      setIsLoadingConversation(deletedState.isLoadingConversation)
      setMetadata(deletedState.metadata)
      setSession(deletedState.session)
      setStatusMessage(deletedState.statusMessage)
      setAllowedAgents(initialAllowedAgents)
      setTargetAgent((current) => initialAllowedAgents.includes(current) ? current : initialAllowedAgents[0] ?? "codex")
      setIsRenameFormOpen(false)
      setRenameDraft("")
      onEntriesChanged([])
      try {
        const replacement = await requestNewConversation(fetch)
        setConversationId(replacement.conversationId)
        setMetadata(replacement.metadata)
        setIsConversationIdentityUnavailable(false)
        setIsReplacingDeletedConversation(false)
        setRenameDraft(replacement.metadata?.title ?? "")
        props.onNewConversation?.()
        setStatusMessage("Conversation deleted.")
      } catch (replacementError) {
        const failureState = buildReplacementFailureState()
        setConversationId(failureState.conversationId)
        setContent(failureState.content)
        setEntries(failureState.entries)
        setEvents(failureState.events)
        setIsLoadingConversation(failureState.isLoadingConversation)
        setMetadata(failureState.metadata)
        setSession(failureState.session)
        setStatusMessage(failureState.statusMessage)
        setIsConversationIdentityUnavailable(failureState.isConversationIdentityUnavailable)
        setIsReplacingDeletedConversation(failureState.replacementInProgress)
        setError(formatError(replacementError))
      }
    } catch (deleteError) {
      setError(formatError(deleteError))
      closeDeleteDialog()
    } finally {
      setActiveManagerAction(undefined)
    }
  }

  const isTurnRunning = isUnbound && session?.turnStatus === "inProgress"
  const isArchivedConversation = metadata?.state === "archived" || currentConversationSummary?.state === "archived"
  const isPaused = isUnbound && session?.status === "paused"
  const visibleActivityEvents = events
    .filter((event) => event.type !== "assistant_delta")
    .slice(-18)
  const liveAssistantText = session?.liveText?.trim()
  const hasCodexSession = isUnbound && !!session
  const agentLiveAssistantText = agentLiveEvents
    .filter((event) => event.type === "assistant_delta")
    .map((event) => event.delta ?? event.text ?? event.message ?? "")
    .join("")
    .trim()
  const agentLiveVisibleEvents = agentLiveEvents
    .filter((event) => event.type !== "assistant_delta")
    .map((event) => ({
      id: event.id,
      type: event.type,
      message: readAgentLiveMessage(event) ?? "Agent activity"
    }))
  const agentLivePanelState = getAgentLivePanelState({
    targetAgent,
    liveSourceAgentId: activeAgentLiveSourceAgentId,
    liveEventAgentId: agentLiveEvents.at(-1)?.agentId,
    hasActiveSource: !!activeEventSource,
    hasActiveSubmission: !!agentLiveSubmissionLifecycleRef.current,
    status: agentLiveStatus,
    reasoning: agentLiveReasoning,
    eventCount: agentLiveEvents.length
  })
  const hasAgentLiveActivity = agentLivePanelState.visible
  const showsCodexSession = hasCodexSession && !hasAgentLiveActivity
  const selectedAgentLabel = getAgentLabel(
    hasAgentLiveActivity
      ? agentLivePanelState.agentId ?? targetAgent
      : "codex"
  )
  const isConversationActionPending = isLoadingConversation || isStartingConversation || !!activeManagerAction
  const areManagerControlsDisabled = isConversationManagerLocked({
    isLoadingConversation,
    isStartingConversation,
    isConversationIdentityUnavailable,
    isReplacingDeletedConversation,
    isControlling,
    isTurnRunning,
    activeManagerAction
  })
  const isConversationSelectable = !areManagerControlsDisabled && conversationOptions.length > 1
  const permissionStatus = permissionMode ? `${formatPermissionMode(permissionMode)} · ` : ""

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) {
      return
    }

    event.preventDefault()
    void submit()
  }

  return (
    <section className="panel taskConversation" aria-label="Conversation">
      <header className="taskConversationHeader" style={{ alignItems: "flex-start" }}>
        <div style={{ display: "grid", gap: "0.25rem", flex: "1 1 14rem", minWidth: 0 }}>
          <p className="eyebrow">Conversation</p>
          <h2 style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {currentConversationTitle}
          </h2>
          <span className="conversationBindingStatus" role="status">
            {props.run ? `${props.run.status.replaceAll("_", " ")} · ` : "No project or task · "}
            {permissionStatus}
            Codex {formatSessionStatus(session)}
          </span>
        </div>
        <div className="taskConversationHeaderActions" style={{ flex: "1 1 18rem", minWidth: 0, justifyContent: "flex-end" }}>
          {isUnbound ? (
            <label style={{ display: "grid", gap: "0.25rem", minWidth: 0, flex: "1 1 12rem" }}>
              <span className="eyebrow" aria-label="Conversation list">Conversations</span>
              <select
                value={activeConversationId ?? ""}
                onChange={(event) => {
                  const nextConversationId = event.target.value
                  if (!nextConversationId) return
                  handleConversationSwitch(nextConversationId)
                }}
                disabled={!isConversationSelectable}
                style={{ minWidth: 0, maxWidth: "100%" }}
              >
                {conversationOptions.map((conversation) => (
                  <option value={conversation.conversationId} key={conversation.conversationId}>
                    {formatConversationOptionLabel(conversation)}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {isUnbound ? (
            <label style={{ alignItems: "center", display: "inline-flex", gap: "0.35rem", minWidth: 0 }}>
              <input
                aria-label="Show archived conversations"
                checked={includeArchived}
                disabled={areManagerControlsDisabled}
                onChange={(event) => setIncludeArchived(event.target.checked)}
                type="checkbox"
              />
              <span>Archived</span>
            </label>
          ) : null}
          {isUnbound && activeConversationId ? (
            <>
              <button
                aria-label="Rename conversation"
                className="compactPanelButton"
                disabled={areManagerControlsDisabled}
                onClick={openRenameDialog}
                ref={renameTriggerRef}
                type="button"
              >
                Rename
              </button>
              <button
                aria-label={isArchivedConversation ? "Unarchive conversation" : "Archive conversation"}
                className="compactPanelButton"
                disabled={areManagerControlsDisabled}
                onClick={() => void handleConversationStateChange(isArchivedConversation ? "active" : "archived")}
                type="button"
              >
                {activeManagerAction === "archive" || activeManagerAction === "unarchive"
                  ? "Saving..."
                  : isArchivedConversation
                    ? "Unarchive"
                    : "Archive"}
              </button>
              <button
                aria-label="Delete conversation"
                className="compactPanelButton danger"
                disabled={areManagerControlsDisabled}
                onClick={openDeleteDialog}
                ref={deleteTriggerRef}
                type="button"
              >
                Delete
              </button>
            </>
          ) : null}
          <button aria-label="New conversation" className="compactPanelButton" disabled={areManagerControlsDisabled} onClick={() => void startNewConversation()} type="button">
            {isLoadingConversation ? "Loading..." : isStartingConversation ? "Starting..." : "New conversation"}
          </button>
        </div>
      </header>
      {isUnbound && activeConversationId ? (
        <dialog
          aria-describedby="rename-conversation-description"
          aria-labelledby="rename-conversation-title"
          onCancel={(event) => {
            event.preventDefault()
            closeRenameDialog()
          }}
          onClose={() => setIsRenameFormOpen(false)}
          open={isRenameFormOpen ? true : undefined}
          ref={renameDialogRef}
          style={{ border: "1px solid var(--border)", borderRadius: "12px", boxShadow: "0 20px 60px rgba(15, 23, 42, 0.28)", maxWidth: "min(32rem, calc(100vw - 2rem))", padding: "1rem", width: "calc(100% - 2rem)" }}
        >
          <form aria-label="Rename conversation form" onSubmit={handleRenameSubmit} style={{ display: "grid", gap: "0.75rem", minWidth: 0 }}>
            <h3 id="rename-conversation-title">Rename conversation</h3>
            <p id="rename-conversation-description">Choose a new name for this conversation.</p>
            <label className="conversationInput" style={{ display: "grid", gap: "0.35rem", minWidth: 0 }}>
              <span>Conversation title</span>
              <input
                maxLength={80}
                onChange={(event) => setRenameDraft(event.target.value)}
                ref={renameInputRef}
                required
                type="text"
                value={renameDraft}
              />
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "flex-end", minWidth: 0 }}>
              <button className="compactPanelButton" disabled={!!activeManagerAction} onClick={closeRenameForm} type="button">
                Cancel
              </button>
              <button className="compactPanelButton" disabled={!!activeManagerAction} type="submit">
                {activeManagerAction === "rename" ? "Saving..." : "Save"}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
      {isUnbound && activeConversationId ? (
        <dialog
          aria-describedby="delete-conversation-description"
          aria-labelledby="delete-conversation-title"
          onCancel={(event) => {
            event.preventDefault()
            closeDeleteDialog()
          }}
          onClose={() => setIsDeleteDialogFallbackOpen(false)}
          open={isDeleteDialogFallbackOpen ? true : undefined}
          ref={deleteDialogRef}
        >
          <form method="dialog" style={{ display: "grid", gap: "0.75rem", minWidth: 0 }}>
            <h3 id="delete-conversation-title">Delete conversation</h3>
            <p id="delete-conversation-description">Delete this conversation and its Codex session?</p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", justifyContent: "flex-end", minWidth: 0 }}>
              <button className="compactPanelButton" onClick={closeDeleteDialog} ref={deleteCancelRef} type="button">
                Cancel
              </button>
              <button className="compactPanelButton danger" disabled={activeManagerAction === "delete"} onClick={() => void handleDeleteConversation()} type="button">
                {activeManagerAction === "delete" ? "Deleting..." : "Delete"}
              </button>
            </div>
          </form>
        </dialog>
      ) : null}
      {statusMessage ? <p role="status">{statusMessage}</p> : null}
      {isUnbound && (showsCodexSession || hasAgentLiveActivity) ? (
        <section className="codexActivity" aria-label={showsCodexSession ? "Codex activity" : "Agent activity"}>
          <div className="codexActivityHeader">
            <div>
              <p className="eyebrow">{showsCodexSession ? "Live Codex session" : "Live Agent session"}</p>
              <strong>{showsCodexSession ? formatSessionStatus(session) : agentLiveStatus ?? "Working"}</strong>
              <p>{selectedAgentLabel}</p>
            </div>
            <div className="codexActivityActions">
              {isTurnRunning ? <button className="compactPanelButton" disabled={isControlling} onClick={() => void control("interrupt")} type="button">Pause</button> : null}
              {isPaused ? <button className="compactPanelButton" disabled={isControlling} onClick={() => void control("resume")} type="button">Continue</button> : null}
              {showsCodexSession && session.status !== "stopped" && session.status !== "failed" && (isTurnRunning || isPaused) ? <button className="compactPanelButton danger" disabled={isControlling} onClick={() => void control("stop")} type="button">Stop</button> : null}
            </div>
          </div>
          {showsCodexSession && visibleActivityEvents.length ? (
            <ol className="codexActivityEvents" aria-live="polite">
              {visibleActivityEvents.map((event) => <li key={event.id}><span>{formatActivityType(event.type)}</span><p>{event.message ?? event.text ?? "Codex activity"}</p></li>)}
            </ol>
          ) : null}
          {!showsCodexSession && agentLiveVisibleEvents.length ? (
            <ol className="codexActivityEvents" aria-live="polite">
              {agentLiveVisibleEvents.map((event) => <li key={event.id}><span>{formatActivityType(event.type)}</span><p>{event.message}</p></li>)}
            </ol>
          ) : null}
          {showsCodexSession && liveAssistantText ? <pre className="codexLiveResponse" aria-live="polite">{liveAssistantText}</pre> : null}
          {!showsCodexSession && agentLiveAssistantText ? <pre className="codexLiveResponse" aria-live="polite">{agentLiveAssistantText}</pre> : null}
          {!showsCodexSession && agentLiveReasoning ? (
            <details>
              <summary>Reasoning preview</summary>
              <pre className="codexLiveResponse" aria-live="polite">{agentLiveReasoning}</pre>
            </details>
          ) : null}
        </section>
      ) : null}
      <ol className="conversationEntries">
        {entries.length ? entries.map((entry) => (
          <li className={`conversationEntry ${entry.role} ${entry.importance}`} key={entry.id}>
            <div className="conversationMeta">
              <strong>{entry.role === "user" ? "You" : getAgentLabel(entry.agentId ?? "codex")}</strong>
              <span>{entry.importance}</span><span>{entry.status}</span>
            </div>
            <p>{entry.content}</p>
            {entry.artifactIds.length || entry.memoryIds.length ? (
              <div className="conversationRefs">
                {entry.artifactIds.map((id) => <a href={`#artifact-${id}`} key={id}>Artifact {id.slice(0, 8)}</a>)}
                {entry.memoryIds.map((id) => <a href={`#memory-${id}`} key={id}>Memory {id.slice(0, 8)}</a>)}
              </div>
            ) : null}
          </li>
        )) : <li className="conversationEmpty">Ask an agent to inspect or use the harness. The conversation stays unbound until a project is clear.</li>}
      </ol>
      <form className="conversationComposer" onSubmit={submit}>
        <label><span>Agent</span><select value={targetAgent} disabled={props.run?.projectType === "arceus_maintenance" || allowedAgents.length <= 1} onChange={(event) => setTargetAgent(event.target.value as AgentKind)}>{allowedAgents.map((agent) => <option value={agent} key={agent}>{getAgentLabel(agent)}</option>)}</select></label>
        <label className="conversationInput"><span>Message</span><textarea disabled={isTurnRunning || isConversationActionPending} onKeyDown={handleComposerKeyDown} value={content} onChange={(event) => setContent(event.target.value)} placeholder={isTurnRunning ? "Codex is working. Pause or wait for the turn to finish." : props.run ? "Ask for progress, evidence, or a scoped action" : targetAgent === "codex" ? "Ask Codex to inspect or use the harness" : `Ask ${getAgentLabel(targetAgent)} for a response`} /></label>
        <button className="primaryButton" disabled={!content.trim() || !allowedAgents.length || !activeConversationId || isTurnRunning || isLoadingConversation || isStartingConversation || !!activeManagerAction}><Send size={16} />Send</button>
      </form>
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </section>
  )
}

async function loadConversation(path: string, requireConversationId = false) {
  const response = await fetch(path, { cache: "no-store" })
  const data = await response.json() as ConversationLoadResult
  if (!response.ok) throw new Error(data.error ?? "Conversation could not be loaded")
  if (requireConversationId && !data.conversationId) {
    throw new Error("Conversation response did not include a conversationId")
  }
  return data
}

function formatSessionStatus(session: CodexConversationState["session"]) {
  if (!session) return "not started"
  if (session.status === "paused") return "paused"
  if (session.status === "stopped") return "stopped"
  if (session.status === "failed") return "failed"
  if (session.turnStatus === "completed") return "ready"
  if (session.turnStatus === "inProgress") return "working"
  return session.status
}

function formatActivityType(type: string) {
  return type.replaceAll("_", " ")
}

function readAgentLiveMessage(event: AgentLiveEvent) {
  return event.message ?? event.text ?? event.delta
}

function mergeResult(current: ConversationEntry[], optimisticId: string, userEntry: ConversationEntry, responseEntry?: ConversationEntry) {
  const withoutOptimistic = current.filter((entry) => entry.id !== optimisticId && entry.id !== userEntry.id && entry.id !== responseEntry?.id)
  return [...withoutOptimistic, userEntry, ...(responseEntry ? [responseEntry] : [])]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

function formatError(error: unknown) { return error instanceof Error ? error.message : String(error) }

export function requestConversationSummaries(
  fetchImpl: typeof fetch,
  includeArchived = false
) {
  const path = includeArchived
    ? "/api/conversations?includeArchived=true"
    : "/api/conversations"
  return requestJson<
    { conversations?: ConversationSummary[]; error?: string },
    ConversationSummary[]
  >(
    fetchImpl,
    path,
    { cache: "no-store" },
    "Conversation list could not be loaded",
    (result) => result.conversations ?? []
  )
}

export function requestNewConversation(fetchImpl: typeof fetch) {
  return requestJson<
    { conversationId?: string; metadata?: ConversationHeaderMetadata; error?: string },
    NewConversationResult
  >(
    fetchImpl,
    "/api/conversation/new",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    },
    "New conversation could not be started",
    (result) => {
      if (!result.conversationId) {
        throw new Error(result.error ?? "New conversation could not be started")
      }
      return {
        conversationId: result.conversationId,
        metadata: result.metadata ?? {
          conversationId: result.conversationId,
          title: "New conversation",
          state: "active"
        }
      } satisfies NewConversationResult
    }
  )
}

export function requestConversationRename(
  fetchImpl: typeof fetch,
  conversationId: string,
  title: string
) {
  const normalized = normalizeConversationTitle(title)
  if (!normalized || normalized.length > 80) {
    throw new Error("title must be between 1 and 80 characters.")
  }
  return requestManagedConversationUpdate(
    fetchImpl,
    conversationId,
    { title: normalized },
    "Conversation could not be renamed"
  )
}

export function requestConversationState(
  fetchImpl: typeof fetch,
  conversationId: string,
  state: ConversationState
) {
  return requestManagedConversationUpdate(
    fetchImpl,
    conversationId,
    { state },
    "Conversation state could not be updated"
  )
}

export async function requestConversationDeletionAndReplacement(
  fetchImpl: typeof fetch,
  conversationId: string
) {
  await requestConversationDeletion(fetchImpl, conversationId)
  return requestNewConversation(fetchImpl)
}

export function buildConversationSwitchState(conversationId: string) {
  return {
    conversationId,
    content: "",
    entries: [],
    error: undefined,
    events: [],
    isLoadingConversation: true,
    session: undefined,
    statusMessage: undefined
  }
}

export function buildDeletedConversationState() {
  return {
    content: "",
    conversationId: undefined,
    entries: [],
    error: undefined,
    events: [],
    isLoadingConversation: true,
    metadata: undefined,
    replacementInProgress: true,
    session: undefined,
    statusMessage: undefined
  }
}

export function buildReplacementFailureState() {
  return {
    content: "",
    conversationId: undefined,
    entries: [],
    error: undefined,
    events: [],
    isConversationIdentityUnavailable: true,
    isLoadingConversation: false,
    metadata: undefined,
    replacementInProgress: false,
    session: undefined,
    statusMessage: undefined
  }
}

export function isConversationManagerLocked(input: {
  isLoadingConversation: boolean
  isStartingConversation: boolean
  isConversationIdentityUnavailable?: boolean
  isReplacingDeletedConversation: boolean
  isControlling: boolean
  isTurnRunning: boolean
  activeManagerAction?: ConversationManagerAction
}) {
  return input.isLoadingConversation
    || input.isStartingConversation
    || input.isReplacingDeletedConversation
    || input.isControlling
    || input.isTurnRunning
    || !!input.activeManagerAction
}

export function shouldSkipUnboundHydration(input: {
  activeConversationId?: string
  isConversationIdentityUnavailable?: boolean
  isReplacingDeletedConversation: boolean
  isUnbound: boolean
}) {
  return input.isUnbound
    && (input.isReplacingDeletedConversation || !!input.isConversationIdentityUnavailable)
    && !input.activeConversationId
}

export async function requestConversationDeletion(
  fetchImpl: typeof fetch,
  conversationId: string
) {
  const response = await fetchImpl(`/api/conversations/${conversationId}`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ confirm: true })
  })
  if (!response.ok) {
    const result = await response.json().catch(() => ({})) as { error?: string }
    throw new Error(result.error ?? "Conversation could not be deleted")
  }
}

function formatConversationOptionLabel(summary: ConversationSummary) {
  const countLabel = `${summary.messageCount} msg${summary.messageCount === 1 ? "" : "s"}`
  const stateLabel = summary.state === "archived" ? "Archived · " : ""
  return `${stateLabel}${summary.title} (${countLabel})`
}

function formatPermissionMode(permissionMode: ConversationPermissionMode) {
  return permissionMode === "full" ? "Full access" : "Restricted access"
}

function normalizeConversationTitle(value: string) {
  return value.trim().replaceAll(/\s+/g, " ")
}

function toConversationHeaderMetadata(summary: ConversationSummary): ConversationHeaderMetadata {
  return {
    conversationId: summary.conversationId,
    title: summary.title,
    state: summary.state
  }
}

function requestManagedConversationUpdate(
  fetchImpl: typeof fetch,
  conversationId: string,
  body: { title?: string; state?: ConversationState },
  fallbackError: string
) {
  return requestJson<ConversationSummary & { error?: string }>(
    fetchImpl,
    `/api/conversations/${conversationId}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    },
    fallbackError
  )
}

async function requestJson<T, TResult = T>(
  fetchImpl: typeof fetch,
  input: string,
  init: RequestInit,
  fallbackError: string,
  select?: (result: T) => TResult
): Promise<TResult> {
  const response = await fetchImpl(input, init)
  const result = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) {
    throw new Error(result.error ?? fallbackError)
  }
  return select ? select(result) : result as unknown as TResult
}
