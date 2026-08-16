"use client"

import { FormEvent, KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import { Send } from "lucide-react"
import type {
  CodexConversationEvent,
  CodexConversationState
} from "@/lib/codex-conversation"
import { getAgentLabel } from "@/lib/agents"
import type { ConversationBinding } from "@/lib/conversation"
import type { ConversationEntry } from "@/lib/hive-memory/types"
import type { AgentKind, WorkflowRun } from "@/lib/types"

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
  const [session, setSession] = useState<CodexConversationState["session"]>()
  const [events, setEvents] = useState<CodexConversationEvent[]>([])
  const [isControlling, setIsControlling] = useState(false)
  const [isLoadingConversation, setIsLoadingConversation] = useState(true)
  const [isStartingConversation, setIsStartingConversation] = useState(false)
  const requestGeneration = useRef(0)
  const pollingInFlight = useRef<{
    generation: number
    promise: ReturnType<typeof loadConversation>
  } | undefined>(undefined)
  const pending = useMemo(() => entries.some((entry) => entry.status === "queued" || entry.status === "running"), [entries])
  const activeConversationId = isUnbound ? conversationId : runId

  function invalidateConversationRequests() {
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

  useEffect(() => {
    let active = true
    const request = loadConversationWithGuard(conversationPath, isUnbound)
    const { generation } = request
    void request.promise.then((data) => {
      if (!active || generation !== requestGeneration.current) return
      setConversationId(data.conversationId ?? runId)
      setEntries(data.entries)
      setAllowedAgents(data.allowedAgents)
      setTargetAgent((current) => data.allowedAgents.includes(current) ? current : data.allowedAgents[0] ?? "codex")
      setSession(data.session)
      setEvents(data.events ?? [])
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
  }, [conversationPath, isUnbound, onEntriesChanged, runId])

  useEffect(() => {
    if (!pending) return
    let active = true
    const timer = window.setInterval(() => {
      if (pollingInFlight.current) return
      const request = loadConversationWithGuard(conversationPath, isUnbound)
      const { generation } = request
      void request.promise.then((data) => {
        if (!active || generation !== requestGeneration.current) return
        setConversationId(data.conversationId ?? runId)
        setEntries(data.entries)
        setSession(data.session)
        setEvents(data.events ?? [])
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
  }, [conversationPath, isUnbound, onEntriesChanged, pending, runId])

  useEffect(() => () => {
    invalidateConversationRequests()
  }, [])

  async function submit(event?: FormEvent) {
    event?.preventDefault()
    const message = content.trim()
    if (!message || allowedAgents.length === 0 || !activeConversationId || isLoadingConversation || isStartingConversation) return
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
    try {
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
      setConversationId(result.conversationId ?? activeConversationId)
      setEntries((current) => result.entries ?? mergeResult(current, optimistic.id, result.userEntry!, result.responseEntry))
      setSession(result.session)
      setEvents(result.events ?? [])
      if (result.binding) props.onBound?.(result.binding)
    } catch (submitError) {
      if (generation !== requestGeneration.current) return
      setEntries((current) => current.map((entry) => entry.id === optimistic.id ? { ...entry, status: "failed" } : entry))
      setError(formatError(submitError))
    }
  }

  async function control(action: "interrupt" | "resume" | "stop") {
    if (!activeConversationId || isLoadingConversation || isStartingConversation) return
    const generation = requestGeneration.current
    setIsControlling(true)
    setError(undefined)
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
    if (isStartingConversation) return

    invalidateConversationRequests()
    setIsStartingConversation(true)
    setError(undefined)
    try {
      const response = await fetch("/api/conversation/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      })
      const result = await response.json() as { conversationId?: string; error?: string }
      if (!response.ok || !result.conversationId) {
        throw new Error(result.error ?? "New conversation could not be started")
      }
      setConversationId(result.conversationId)
      setEntries([])
      setAllowedAgents(initialAllowedAgents)
      setTargetAgent((current) => initialAllowedAgents.includes(current) ? current : initialAllowedAgents[0] ?? "codex")
      setContent("")
      setSession(undefined)
      setEvents([])
      onEntriesChanged([])
      props.onNewConversation?.()
    } catch (startError) {
      setError(formatError(startError))
    } finally {
      setIsStartingConversation(false)
    }
  }

  const isTurnRunning = isUnbound && session?.turnStatus === "inProgress"
  const isPaused = isUnbound && session?.status === "paused"
  const visibleActivityEvents = events
    .filter((event) => event.type !== "assistant_delta")
    .slice(-18)
  const liveAssistantText = session?.liveText?.trim()
  const isConversationActionPending = isLoadingConversation || isStartingConversation

  function handleComposerKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) {
      return
    }

    event.preventDefault()
    void submit()
  }

  return (
    <section className="panel taskConversation" aria-label="Conversation">
      <header className="taskConversationHeader">
        <div><p className="eyebrow">Conversation</p><h2>{props.run?.projectName ?? "Unbound conversation"}</h2></div>
        <div className="taskConversationHeaderActions">
          {props.run ? <span className={`status ${props.run.status}`}>{props.run.status.replaceAll("_", " ")}</span> : <span className="conversationBindingStatus">No project or task · Codex {formatSessionStatus(session)}</span>}
          <button aria-label="New conversation" className="compactPanelButton" disabled={isConversationActionPending} onClick={() => void startNewConversation()} type="button">
            {isLoadingConversation ? "Loading..." : isStartingConversation ? "Starting..." : "New conversation"}
          </button>
        </div>
      </header>
      {isUnbound && session ? (
        <section className="codexActivity" aria-label="Codex activity">
          <div className="codexActivityHeader">
            <div>
              <p className="eyebrow">Live Codex session</p>
              <strong>{formatSessionStatus(session)}</strong>
            </div>
            <div className="codexActivityActions">
              {isTurnRunning ? <button className="compactPanelButton" disabled={isControlling} onClick={() => void control("interrupt")} type="button">Pause</button> : null}
              {isPaused ? <button className="compactPanelButton" disabled={isControlling} onClick={() => void control("resume")} type="button">Continue</button> : null}
              {session.status !== "stopped" && session.status !== "failed" && (isTurnRunning || isPaused) ? <button className="compactPanelButton danger" disabled={isControlling} onClick={() => void control("stop")} type="button">Stop</button> : null}
            </div>
          </div>
          {visibleActivityEvents.length ? (
            <ol className="codexActivityEvents" aria-live="polite">
              {visibleActivityEvents.map((event) => <li key={event.id}><span>{formatActivityType(event.type)}</span><p>{event.message ?? event.text ?? "Codex activity"}</p></li>)}
            </ol>
          ) : null}
          {liveAssistantText ? <pre className="codexLiveResponse" aria-live="polite">{liveAssistantText}</pre> : null}
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
        <label className="conversationInput"><span>Message</span><textarea disabled={isTurnRunning} onKeyDown={handleComposerKeyDown} value={content} onChange={(event) => setContent(event.target.value)} placeholder={isTurnRunning ? "Codex is working. Pause or wait for the turn to finish." : props.run ? "Ask for progress, evidence, or a scoped action" : targetAgent === "codex" ? "Ask Codex to inspect or use the harness" : `Ask ${getAgentLabel(targetAgent)} for a response`} /></label>
        <button className="primaryButton" disabled={!content.trim() || !allowedAgents.length || !activeConversationId || isTurnRunning || isLoadingConversation || isStartingConversation}><Send size={16} />Send</button>
      </form>
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </section>
  )
}

async function loadConversation(path: string, requireConversationId = false) {
  const response = await fetch(path, { cache: "no-store" })
  const data = await response.json() as Partial<CodexConversationState> & {
    entries: ConversationEntry[]
    allowedAgents: AgentKind[]
    error?: string
  }
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

function mergeResult(current: ConversationEntry[], optimisticId: string, userEntry: ConversationEntry, responseEntry?: ConversationEntry) {
  const withoutOptimistic = current.filter((entry) => entry.id !== optimisticId && entry.id !== userEntry.id && entry.id !== responseEntry?.id)
  return [...withoutOptimistic, userEntry, ...(responseEntry ? [responseEntry] : [])]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

function formatError(error: unknown) { return error instanceof Error ? error.message : String(error) }
