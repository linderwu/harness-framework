import { agentProfiles, normalizeAgentKind } from "./agents"
import {
  createConversationId,
  legacyConversationId
} from "./conversation-identity"
import { ConversationLifecycleService } from "./conversation-lifecycle/service"
import type { ProviderDeliveryState } from "./conversation-lifecycle/types"
import type { ContextPack } from "./context-builder"
import type {
  ConversationDispatchOutcome,
  ConversationQueueResult
} from "./conversation-dispatcher"
import type { HiveMemoryRepository } from "./hive-memory/repository"
import type { ConversationEntry } from "./hive-memory/types"
import type { ManagerWakeReason } from "./manager-scheduler"
import type { AgentKind, CodexReasoningIntensity, WorkflowRun } from "./types"

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
    return (
      health.codex === "offline" || health.codex === "disabled"
        ? []
        : (["codex"] as AgentKind[])
    )
  }

  return agentProfiles
    .map((profile) => profile.id)
    .filter((agent) => health[agent] !== "offline" && health[agent] !== "disabled")
}

interface ConversationDependencies {
  repository: HiveMemoryRepository
  lifecycle: ConversationLifecycleService
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
    conversationId?: string
  }) => Promise<{
    status: "completed" | "failed"
    body: string
    deliveryState?: ProviderDeliveryState
  }>
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
  enqueueConversation?: (input: {
    conversationId: string
    targetAgent: AgentKind
    content: string
    idempotencyKey: string
    responseRole?: "agent" | "manager"
  }) => Promise<ConversationQueueResult>
  routeUnbound?: (input: {
    conversationId: string
    content: string
    entries: ConversationEntry[]
    targetAgent: AgentKind
    idempotencyKey: string
    selectedModelId?: string
    selectedReasoningIntensity?: CodexReasoningIntensity
  }) => Promise<{
    status: "completed" | "failed"
    body: string
    deliveryState?: ProviderDeliveryState
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
      metadata: this.dependencies.repository.getConversationMetadata(conversationId),
      binding: undefined
    }
  }

  startNewConversation() {
    return createConversationId()
  }

  async enqueueUnboundMessage(input: {
    conversationId?: string
    content: string
    targetAgent?: AgentKind
    idempotencyKey: string
    selectedModelId?: unknown
    selectedReasoningIntensity?: unknown
  }) {
    const conversationId = input.conversationId ?? unboundConversationId
    const content = input.content.trim()
    const targetAgent = normalizeAgentKind(input.targetAgent)
    const health = await this.dependencies.getHealth?.() ?? {}
    const allowedAgents = listAllowedAgents("development", health)

    if (!content) throw new ConversationError("content is required", 400)
    if (!input.idempotencyKey.trim()) throw new ConversationError("idempotencyKey is required", 400)
    if (!allowedAgents.includes(targetAgent)) {
      throw new ConversationError("Target agent is not allowed for unbound conversation", 403)
    }
    const selectedModelId = targetAgent === "codex"
      ? parseUnboundSelectedModelId(input.selectedModelId)
      : undefined
    const selectedReasoningIntensity = targetAgent === "codex"
      ? parseUnboundSelectedReasoningIntensity(input.selectedReasoningIntensity)
      : undefined
    const validatedTurn = this.dependencies.lifecycle.validateSubmitTurn({
      content,
      idempotencyKey: input.idempotencyKey,
      responseRole: "agent"
    })

    await this.dependencies.lifecycle.openConversation({
      conversationId,
      title: "New conversation"
    })
    const storageIdempotencyKey = toConversationTurnStorageKey(
      conversationId,
      validatedTurn.idempotencyKey
    )
    const existing = storageIdempotencyKey
      ? this.dependencies.repository.getConversationByIdempotencyKey(storageIdempotencyKey)
      : undefined
    if (
      storageIdempotencyKey &&
      !existing &&
      (selectedModelId !== undefined || selectedReasoningIntensity !== undefined)
    ) {
      await this.dependencies.lifecycle.updateConversationSettings({
        conversationId,
        selectedModelId,
        selectedReasoningIntensity
      })
    }
    const submitted = await this.dependencies.lifecycle.submitTurn({
      conversationId,
      targetAgent,
      content,
      idempotencyKey: input.idempotencyKey,
      responseRole: "agent"
    })
    return {
      conversationId: submitted.conversationId,
      status: submitted.jobStatus,
      jobId: submitted.jobId,
      jobStatus: submitted.jobStatus,
      userEntry: submitted.userEntry,
      responseEntry: submitted.responseEntry,
      duplicate: submitted.duplicate
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
        run,
        targetAgent: input.targetAgent,
        content,
        contextPack,
        managerRouting,
        conversationId: run.id
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

  async enqueueMessage(input: {
    workflowRunId: string
    targetAgent: AgentKind
    content: string
    replyToId?: string
    idempotencyKey: string
  }) {
    const content = input.content.trim()
    if (!content) throw new ConversationError("content is required", 400)
    if (!input.idempotencyKey.trim()) throw new ConversationError("idempotencyKey is required", 400)
    if (!this.dependencies.enqueueConversation) {
      throw new ConversationError("Conversation queue is unavailable", 503)
    }

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

    const managerRouting = run.projectType === "hive_mission" && input.targetAgent === "codex"
    const workerDirected = run.projectType === "hive_mission" && input.targetAgent !== "codex"
    const queued = await this.dependencies.enqueueConversation({
      conversationId: run.id,
      targetAgent: input.targetAgent,
      content,
      idempotencyKey: input.idempotencyKey,
      responseRole: managerRouting ? "manager" : "agent"
    })

    if (workerDirected) {
      await this.dependencies.repository.appendEvent({
        eventType: "worker_message_visible_to_manager",
        actor: "human",
        workflowRunId: run.id,
        payload: { conversationEntryId: queued.userEntry.id, targetAgent: input.targetAgent },
        idempotencyKey: `manager-visible:${input.idempotencyKey}`
      })
      await this.dependencies.enqueueManagerWake({
        workflowRunId: run.id,
        reason: "worker_message",
        idempotencyKey: `conversation-wake:${input.idempotencyKey}`
      })
    }

    return { status: queued.jobStatus, ...queued }
  }

  async dispatchQueuedEntry(input: {
    conversationId: string
    targetAgent: AgentKind
    userEntry: ConversationEntry
    responseEntry?: ConversationEntry
  }): Promise<ConversationDispatchOutcome> {
    const { conversationId, targetAgent, userEntry, responseEntry } = input
    const allEntries = this.dependencies.repository.listConversation(conversationId)
    const userIndex = allEntries.findIndex((entry) => entry.id === userEntry.id)
    const entriesThroughCurrent = userIndex === -1
      ? [userEntry]
      : allEntries.slice(0, userIndex + 1)
    const run = await this.dependencies.getRun(conversationId)
    if (!run) {
      if (!this.dependencies.routeUnbound) {
        throw new ConversationError("Conversation manager is unavailable", 503)
      }
      const decision = await this.dependencies.routeUnbound({
        conversationId,
        targetAgent,
        content: userEntry.content,
        entries: entriesThroughCurrent,
        idempotencyKey: userEntry.idempotencyKey,
        selectedModelId: targetAgent === "codex"
          ? this.dependencies.repository.getConversationMetadata(conversationId)?.selectedModelId
          : undefined,
        selectedReasoningIntensity: targetAgent === "codex"
          ? this.dependencies.repository.getConversationMetadata(conversationId)?.selectedReasoningIntensity
          : undefined
      })
      if (targetAgent === "codex" && decision.binding) {
        await this.dependencies.repository.moveConversation(conversationId, decision.binding.workflowRunId)
      }
      return {
        status: decision.status,
        body: decision.body,
        ...(decision.deliveryState ? { deliveryState: decision.deliveryState } : {})
      }
    }

    const managerRouting = run.projectType === "hive_mission" && targetAgent === "codex"
    const contextPack = await this.dependencies.buildContext({
      run,
      targetAgent,
      entries: entriesThroughCurrent,
      content: userEntry.content
    })
    await this.dependencies.repository.updateConversation({
      id: userEntry.id,
      status: "running",
      memoryIds: contextPack?.memoryIds ?? []
    })
    const result = await this.dependencies.invokeAgent({
      run,
      targetAgent,
      content: userEntry.content,
      contextPack,
      managerRouting,
      conversationId: run.id
    })
    const artifactId = await this.dependencies.persistRawArtifact({
      run,
      targetAgent,
      body: result.body
    })
    if (responseEntry) {
      await this.dependencies.repository.updateConversation({
        id: responseEntry.id,
        artifactIds: [artifactId],
        memoryIds: contextPack?.memoryIds ?? []
      })
    }
    await this.dependencies.repository.updateConversation({
      id: userEntry.id,
      artifactIds: [artifactId],
      memoryIds: contextPack?.memoryIds ?? []
    })
    if (managerRouting) {
      await this.dependencies.enqueueManagerWake({
        workflowRunId: run.id,
        reason: "operator_message",
        idempotencyKey: `conversation-wake:${userEntry.idempotencyKey}`
      })
    }
    return {
      status: result.status,
      body: compactAgentResultBody(result.body),
      ...(result.deliveryState ? { deliveryState: result.deliveryState } : {})
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

function parseUnboundSelectedModelId(value: unknown): string | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null
  if (typeof value !== "string") {
    throw new ConversationError(
      "selectedModelId must be absent, empty, or a string up to 120 characters.",
      400
    )
  }

  const normalized = value.trim()
  if (normalized.length > 120) {
    throw new ConversationError(
      "selectedModelId must be absent, empty, or a string up to 120 characters.",
      400
    )
  }

  return normalized || null
}

function parseUnboundSelectedReasoningIntensity(value: unknown): CodexReasoningIntensity | null | undefined {
  if (value === undefined) return undefined
  if (value === null) return null

  if (value !== "auto" && value !== "low" && value !== "medium" && value !== "high") {
    throw new ConversationError(
      "selectedReasoningIntensity must be absent, null, auto, low, medium, or high.",
      400
    )
  }

  return value
}

function compactAgentResultBody(body: string) {
  return body.length <= 4_000 ? body : body.slice(0, 4_000)
}

function toConversationTurnStorageKey(
  conversationId: string,
  idempotencyKey: string
) {
  try {
    return `${conversationId}:${encodeURIComponent(idempotencyKey.trim())}`
  } catch (error) {
    if (error instanceof URIError) return undefined
    throw error
  }
}
