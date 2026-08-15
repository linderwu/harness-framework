"use client"

import { FormEvent, useEffect, useMemo, useState } from "react"
import { Send } from "lucide-react"
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
}) {
  const runId = props.run?.id
  const conversationPath = runId ? `/api/workflow-runs/${runId}/conversation` : "/api/conversation"
  const onEntriesChanged = props.onEntriesChanged
  const [entries, setEntries] = useState(props.initialEntries)
  const [allowedAgents, setAllowedAgents] = useState(props.allowedAgents)
  const [targetAgent, setTargetAgent] = useState<AgentKind>(props.allowedAgents[0] ?? "codex")
  const [content, setContent] = useState("")
  const [error, setError] = useState<string>()
  const pending = useMemo(() => entries.some((entry) => entry.status === "queued" || entry.status === "running"), [entries])

  useEffect(() => {
    let active = true
    void loadConversation(conversationPath).then((data) => {
      if (!active) return
      setEntries(data.entries)
      setAllowedAgents(data.allowedAgents)
      setTargetAgent((current) => data.allowedAgents.includes(current) ? current : data.allowedAgents[0] ?? "codex")
      onEntriesChanged(data.entries)
    }).catch((loadError) => active && setError(formatError(loadError)))
    return () => { active = false }
  }, [conversationPath, onEntriesChanged])

  useEffect(() => {
    if (!pending) return
    const timer = window.setInterval(() => {
      void loadConversation(conversationPath).then((data) => {
        setEntries(data.entries)
        onEntriesChanged(data.entries)
      }).catch((loadError) => setError(formatError(loadError)))
    }, 3_000)
    return () => window.clearInterval(timer)
  }, [conversationPath, onEntriesChanged, pending])

  async function submit(event: FormEvent) {
    event.preventDefault()
    const message = content.trim()
    if (!message || allowedAgents.length === 0) return
    const idempotencyKey = crypto.randomUUID()
    const optimistic: ConversationEntry = {
      id: `optimistic:${idempotencyKey}`,
      workflowRunId: runId ?? "global:unbound-conversation",
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
        body: JSON.stringify({ targetAgent, content: message, idempotencyKey })
      })
      const result = await response.json() as {
        error?: string
        userEntry?: ConversationEntry
        responseEntry?: ConversationEntry
        binding?: ConversationBinding
      }
      if (!response.ok || !result.userEntry) throw new Error(result.error ?? "Message dispatch failed")
      setEntries((current) => mergeResult(current, optimistic.id, result.userEntry!, result.responseEntry))
      if (result.binding) props.onBound?.(result.binding)
    } catch (submitError) {
      setEntries((current) => current.map((entry) => entry.id === optimistic.id ? { ...entry, status: "failed" } : entry))
      setError(formatError(submitError))
    }
  }

  return (
    <section className="panel taskConversation" aria-label="Conversation">
      <header className="taskConversationHeader">
        <div><p className="eyebrow">Conversation</p><h2>{props.run?.projectName ?? "Unbound conversation"}</h2></div>
        {props.run ? <span className={`status ${props.run.status}`}>{props.run.status.replaceAll("_", " ")}</span> : <span className="conversationBindingStatus">No project or task</span>}
      </header>
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
        )) : <li className="conversationEmpty">Start anywhere. The manager will bind this conversation only when a project is clear.</li>}
      </ol>
      <form className="conversationComposer" onSubmit={submit}>
        <label><span>Agent</span><select value={targetAgent} disabled={props.run?.projectType === "arceus_maintenance" || allowedAgents.length <= 1} onChange={(event) => setTargetAgent(event.target.value as AgentKind)}>{allowedAgents.map((agent) => <option value={agent} key={agent}>{getAgentLabel(agent)}</option>)}</select></label>
        <label className="conversationInput"><span>Message</span><textarea value={content} onChange={(event) => setContent(event.target.value)} placeholder={props.run ? "Ask for progress, evidence, or a scoped action" : targetAgent === "codex" ? "Ask anything; the manager will decide whether it belongs to a project" : "Limited mode: ask guidance or questions only; no project/workflow actions."} /></label>
        <button className="primaryButton" disabled={!content.trim() || !allowedAgents.length}><Send size={16} />Send</button>
      </form>
      {error ? <p className="formError" role="alert">{error}</p> : null}
    </section>
  )
}

async function loadConversation(path: string) {
  const response = await fetch(path, { cache: "no-store" })
  const data = await response.json() as { error?: string; entries: ConversationEntry[]; allowedAgents: AgentKind[] }
  if (!response.ok) throw new Error(data.error ?? "Conversation could not be loaded")
  return data
}

function mergeResult(current: ConversationEntry[], optimisticId: string, userEntry: ConversationEntry, responseEntry?: ConversationEntry) {
  const withoutOptimistic = current.filter((entry) => entry.id !== optimisticId && entry.id !== userEntry.id && entry.id !== responseEntry?.id)
  return [...withoutOptimistic, userEntry, ...(responseEntry ? [responseEntry] : [])]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id))
}

function formatError(error: unknown) { return error instanceof Error ? error.message : String(error) }
