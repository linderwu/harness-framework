import { agentProfiles, normalizeAgentKind } from "./agents"
import {
  createConversationId,
  legacyConversationId
} from "./conversation-identity"
import type { ContextPack } from "./context-builder"
import type { HiveMemoryRepository } from "./hive-memory/repository"
import type { ConversationEntry } from "./hive-memory/types"
import type { ManagerWakeReason } from "./manager-scheduler"
import type { AgentKind, WorkflowRun } from "./types"

export const unboundConversationId = legacyConversationId

export interface ConversationBinding {
  projectId: string
  workflowRunId: string
  projectName: string
}

export type AgentAvailability = "online" | "busy" | "offline" | "disabled"
export type AgentHealth = Partial<Record<AgentKind, AgentAvailability>>

export class ConversationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export function listAllowedAgents(
  projectType: WorkflowRun["projectType"],
  health: AgentHealth = {}
) {
  if (projectType === "arceus_maintenance") {
    return health.codex === "offline" || health.codex === "disabled" ? [] : ["codex"] satisfies AgentKind[]
  }

  return agentProfiles
    .map((profile) => profile.id)
    .filter((agent) => health[agent] !== "offline" && health[agent] !== "disabled")
}

interface ConversationDependencies {
  repository: HiveMemoryRepository
  getRun: (id: string) => Promise<WorkflowRun | undefined>
  getHealth?: () => Promise<AgentHealth> | AgentHealth
  buildContext: (input: {
    run: WorkflowRun
    targetAgent: AgentKind
    entries: ConversationEntry[]
    content: string
  }) => Promise<ContextPack | undefined>
  invokeAgent: (input: {
    run: WorkflowRun
    targetAgent: AgentKind
    content: string
    contextPack?: ContextPack
    managerRouting: boolean
  }) => Promise<{ status: "completed" | "failed"; body: string }>
  persistRawArtifact: (input: {
    run: WorkflowRun
    targetAgent: AgentKind
    body: string
  }) => Promise<string>
  enqueueManagerWake: (input: {
    workflowRunId: string
    reason: ManagerWakeReason
    idempotencyKey: string
  }) => Promise<unknown>
  routeUnbound?: (input: {
    conversationId: string
    content: string
    entries: ConversationEntry[]
    targetAgent: AgentKind
  }) => Promise<{
    status: "completed" | "failed"
    body: string
    binding?: ConversationBinding
  }>
}

export class ConversationService {
  constructor(private readonly dependencies: ConversationDependencies) {}

  async getConversation(workflowRunId: string) {
    const run = await this.requireRun(workflowRunId)
    const health = await this.dependencies.getHealth?.() ?? {}
    return {
      entries: this.dependencies.repository.listConversation(workflowRunId),
      allowedAgents: listAllowedAgents(run.projectType, health)
    }
  }

  async getUnboundConversation(conversationId = unboundConversationId) {
    const health = await this.dependencies.getHealth?.() ?? {}
    return {
      conversationId,
      entries: this.dependencies.repository.listConversation(conversationId),
      allowedAgents: listAllowedAgents("development", health),
      binding: undefined
    }
  }

  startNewConversation() {
    return createConversationId()
  }

  async postUnboundMessage(input: {
    conversationId?: string
    content: string
    targetAgent?: AgentKind
    idempotencyKey: string
  }) {
    const conversationId = input.conversationId ?? unboundConversationId
    const content = input.content.trim()
    const targetAgent = normalizeAgentKind(input.targetAgent)
    const health = await this.dependencies.getHealth?.() ?? {}
    const allowedAgents = listAllowedAgents("development", health)
    const storageIdempotencyKey = toConversationScopedIdempotencyKey(
      conversationId,
      input.idempotencyKey
    )

    if (!content) throw new ConversationError("content is required", 400)
    if (!input.idempotencyKey.trim()) throw new ConversationError("idempotencyKey is required", 400)
    if (!allowedAgents.includes(targetAgent)) {
      throw new ConversationError("Target agent is not allowed for unbound conversation", 403)
    }
    if (!this.dependencies.routeUnbound) throw new ConversationError("Conversation manager is unavailable", 503)

    const existing = this.dependencies.repository.getConversationByIdempotencyKey(storageIdempotencyKey)
    if (existing) return this.duplicateUnboundResult(existing, conversationId)

    const userInsert = await this.dependencies.repository.insertConversation({
      workflowRunId: conversationId,
      role: "user",
      agentId: targetAgent,
      content,
      importance: "normal",
      status: "queued",
      artifactIds: [],
      memoryIds: [],
      idempotencyKey: storageIdempotencyKey
    })
    const userEntry = userInsert.entry
    if (!userInsert.inserted) return this.duplicateUnboundResult(userEntry, conversationId)

    try {
      await this.dependencies.repository.updateConversation({ id: userEntry.id, status: "running" })
      const decision = await this.dependencies.routeUnbound({
        conversationId,
        targetAgent,
        content,
        entries: this.dependencies.repository.listConversation(conversationId)
      })
      const responseInsert = await this.dependencies.repository.insertConversation({
        workflowRunId: conversationId,
        role: targetAgent === "codex" ? "manager" : "agent",
        agentId: targetAgent,
        content: compactResponse(decision.body),
        importance: decision.status === "failed" ? "critical" : "important",
        status: decision.status,
        replyToId: userEntry.id,
        artifactIds: [],
        memoryIds: [],
        idempotencyKey: `${storageIdempotencyKey}:response`
      })
      await this.dependencies.repository.updateConversation({
        id: userEntry.id,
        status: decision.status === "completed" ? "completed" : "failed"
      })
      if (targetAgent === "codex" && decision.binding) {
        await this.dependencies.repository.moveConversation(conversationId, decision.binding.workflowRunId)
      }
      return {
        conversationId,
        userEntry: this.dependencies.repository.getConversationEntry(userEntry.id)!,
        responseEntry: this.dependencies.repository.getConversationEntry(responseInsert.entry.id)!,
        binding: decision.binding,
        duplicate: false
      }
    } catch (error) {
      await this.dependencies.repository.updateConversation({ id: userEntry.id, status: "failed" })
      throw error
    }
  }

  async postMessage(input: {
    workflowRunId: string
    targetAgent: AgentKind
    content: string
    replyToId?: string
    idempotencyKey: string
  }) {
    const content = input.content.trim()
    if (!content) throw new ConversationError("content is required", 400)
    if (!input.idempotencyKey.trim()) throw new ConversationError("idempotencyKey is required", 400)

    const existing = this.dependencies.repository.getConversationByIdempotencyKey(input.idempotencyKey)
    if (existing) return this.duplicateResult(existing)

    const run = await this.requireRun(input.workflowRunId)
    const health = await this.dependencies.getHealth?.() ?? {}
    if (!listAllowedAgents(run.projectType, health).includes(input.targetAgent)) {
      throw new ConversationError("Target agent is not allowed for this workflow run", 403)
    }
    if (input.replyToId) {
      const reply = this.dependencies.repository.getConversationEntry(input.replyToId)
      if (!reply || reply.workflowRunId !== run.id) throw new ConversationError("replyToId is not part of this workflow run", 400)
    }

    const userInsert = await this.dependencies.repository.insertConversation({
      workflowRunId: run.id,
      role: "user",
      agentId: input.targetAgent,
      content,
      importance: "normal",
      status: "queued",
      replyToId: input.replyToId,
      artifactIds: [],
      memoryIds: [],
      idempotencyKey: input.idempotencyKey
    })
    const userEntry = userInsert.entry
    if (!userInsert.inserted) return this.duplicateResult(userEntry)

    const managerRouting = run.projectType === "hive_mission" && input.targetAgent === "codex"
    const workerDirected = run.projectType === "hive_mission" && input.targetAgent !== "codex"
    if (workerDirected) {
      await this.dependencies.repository.appendEvent({
        eventType: "worker_message_visible_to_manager",
        actor: "human",
        workflowRunId: run.id,
        payload: { conversationEntryId: userEntry.id, targetAgent: input.targetAgent },
        idempotencyKey: `manager-visible:${input.idempotencyKey}`
      })
      await this.dependencies.enqueueManagerWake({
        workflowRunId: run.id,
        reason: "worker_message",
        idempotencyKey: `conversation-wake:${input.idempotencyKey}`
      })
    }

    if (health[input.targetAgent] === "busy") return { userEntry, responseEntry: undefined, duplicate: false }

    try {
      const contextPack = await this.dependencies.buildContext({
        run,
        targetAgent: input.targetAgent,
        entries: this.dependencies.repository.listConversation(run.id),
        content
      })
      await this.dependencies.repository.updateConversation({ id: userEntry.id, status: "running", memoryIds: contextPack?.memoryIds ?? [] })
      const result = await this.dependencies.invokeAgent({
        run, targetAgent: input.targetAgent, content, contextPack, managerRouting
      })
      const artifactId = await this.dependencies.persistRawArtifact({ run, targetAgent: input.targetAgent, body: result.body })
      const responseInsert = await this.dependencies.repository.insertConversation({
        workflowRunId: run.id,
        role: managerRouting ? "manager" : "agent",
        agentId: input.targetAgent,
        content: compactAgentResultBody(result.body),
        importance: result.status === "failed" ? "critical" : "important",
        status: result.status,
        replyToId: userEntry.id,
        artifactIds: [artifactId],
        memoryIds: contextPack?.memoryIds ?? [],
        idempotencyKey: `${input.idempotencyKey}:response`
      })
      const responseEntry = responseInsert.entry
      await this.dependencies.repository.updateConversation({
        id: userEntry.id,
        status: result.status === "completed" ? "completed" : "failed",
        artifactIds: [artifactId],
        memoryIds: contextPack?.memoryIds ?? []
      })
      if (managerRouting) {
        await this.dependencies.enqueueManagerWake({
          workflowRunId: run.id,
          reason: "operator_message",
          idempotencyKey: `conversation-wake:${input.idempotencyKey}`
        })
      }
      return { userEntry: this.dependencies.repository.getConversationEntry(userEntry.id)!, responseEntry, duplicate: false }
    } catch (error) {
      await this.dependencies.repository.updateConversation({ id: userEntry.id, status: "failed" })
      throw error
    }
  }

  private async requireRun(id: string) {
    const run = await this.dependencies.getRun(id)
    if (!run) throw new ConversationError("Workflow run not found", 404)
    return run
  }

  private duplicateResult(userEntry: ConversationEntry) {
    return {
      userEntry,
      responseEntry: this.dependencies.repository.getConversationByIdempotencyKey(`${userEntry.idempotencyKey}:response`),
      duplicate: true
    }
  }

  private async duplicateUnboundResult(userEntry: ConversationEntry, conversationId: string) {
    const run = userEntry.workflowRunId === unboundConversationId
      ? undefined
      : await this.dependencies.getRun(userEntry.workflowRunId)
    return {
      conversationId,
      userEntry,
      responseEntry: this.dependencies.repository.getConversationByIdempotencyKey(`${userEntry.idempotencyKey}:response`),
      binding: run ? { projectId: run.projectId, workflowRunId: run.id, projectName: run.projectName } : undefined,
      duplicate: true
    }
  }
}

export function createConversationService(dependencies: ConversationDependencies) {
  return new ConversationService(dependencies)
}

export function parseUnboundManagerDecision(raw: string, runs: WorkflowRun[]) {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    throw new Error("Conversation manager response must be one valid JSON object.")
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Conversation manager response must be one valid JSON object.")
  }
  const decision = value as Record<string, unknown>
  if (typeof decision.reply !== "string" || !decision.reply.trim()) {
    throw new Error("Conversation manager response requires a reply.")
  }
  const projectId = typeof decision.projectId === "string" ? decision.projectId : undefined
  const workflowRunId = typeof decision.workflowRunId === "string" ? decision.workflowRunId : undefined
  if (!projectId && !workflowRunId) return { body: decision.reply.trim() }
  if (!projectId || !workflowRunId) {
    throw new Error("Conversation manager must provide both projectId and workflowRunId when binding.")
  }
  const run = runs.find((candidate) => candidate.id === workflowRunId && candidate.projectId === projectId)
  if (!run) throw new Error("Conversation manager selected an invalid project or workflow run.")
  return {
    body: decision.reply.trim(),
    binding: { projectId: run.projectId, workflowRunId: run.id, projectName: run.projectName }
  }
}

function compactResponse(body: string) {
  const normalized = body.trim()
  return normalized.length <= 4_000 ? normalized : normalized.slice(0, 4_000)
}

function compactAgentResultBody(body: string) {
  return body.length <= 4_000 ? body : body.slice(0, 4_000)
}

function toConversationScopedIdempotencyKey(
  conversationId: string,
  idempotencyKey: string
) {
  return `${conversationId}:${idempotencyKey.trim()}`
}
