import type { AgentKind } from "./types"
import type { ConversationEntry } from "./hive-memory/types"
import type { HiveMemoryRepository } from "./hive-memory/repository"
import type { ExecutionJob } from "./hive-memory/types"
import { ConversationLifecycleService } from "./conversation-lifecycle/service"
import {
  isLifecycleOwnedConversationId,
  type ProviderOutcome,
  type SettledTurnAggregate,
  type TurnDispatchEnvelope
} from "./conversation-lifecycle/types"

export interface ConversationDispatchInput {
  conversationId: string
  targetAgent: AgentKind
  content: string
  userEntry: ConversationEntry
  responseEntry?: ConversationEntry
}

export interface ConversationDispatchOutcome {
  status: "completed" | "interrupted" | "failed"
  body: string
  deliveryState?: "confirmed" | "unknown"
}

export type ConversationTurnPublication = (settled: SettledTurnAggregate) => Promise<unknown> | unknown

export interface ConversationQueueResult {
  userEntry: ConversationEntry
  responseEntry: ConversationEntry
  jobId: string
  jobStatus: ExecutionJob["status"]
  duplicate: boolean
}

export class ConversationQueueService {
  constructor(private readonly repository: HiveMemoryRepository) {}

  async enqueue(input: {
    conversationId: string
    targetAgent: AgentKind
    content: string
    idempotencyKey: string
    responseRole?: "agent" | "manager"
  }): Promise<ConversationQueueResult> {
    const content = input.content.trim()
    if (!content) throw new Error("content is required")
    if (!input.idempotencyKey.trim()) throw new Error("idempotencyKey is required")

    const storageKey = `${input.conversationId}:${input.idempotencyKey.trim()}`
    const existing = this.repository.getConversationByIdempotencyKey(storageKey)
    if (existing) {
      const responseEntry = this.repository.getConversationByIdempotencyKey(`${storageKey}:response`)
      const job = this.repository.getExecutionJobByIdempotencyKey(`${storageKey}:dispatch`)
      if (!responseEntry || !job) throw new Error("Conversation queue record is incomplete.")
      return {
        userEntry: existing,
        responseEntry,
        jobId: job.id,
        jobStatus: job.status,
        duplicate: true
      }
    }

    const userInsert = await this.repository.insertConversation({
      workflowRunId: input.conversationId,
      role: "user",
      agentId: input.targetAgent,
      content,
      importance: "normal",
      status: "queued",
      artifactIds: [],
      memoryIds: [],
      idempotencyKey: storageKey
    })
    const responseInsert = await this.repository.insertConversation({
      workflowRunId: input.conversationId,
      role: input.responseRole ?? "agent",
      agentId: input.targetAgent,
      content: "Queued for agent response...",
      importance: "important",
      status: "queued",
      replyToId: userInsert.entry.id,
      artifactIds: [],
      memoryIds: [],
      idempotencyKey: `${storageKey}:response`
    })
    const dispatch = await this.repository.createConversationDispatch({
      conversationId: input.conversationId,
      entryId: userInsert.entry.id,
      responseEntryId: responseInsert.entry.id,
      targetAgent: input.targetAgent,
      idempotencyKey: `${storageKey}:dispatch`
    })
    return {
      userEntry: userInsert.entry,
      responseEntry: responseInsert.entry,
      jobId: dispatch.job.id,
      jobStatus: dispatch.job.status,
      duplicate: false
    }
  }

  listPending(conversationId: string) {
    return this.repository.listConversation(conversationId).filter(
      (entry) => entry.role === "user" && entry.status === "queued"
    )
  }

  async cancelPending(conversationId: string) {
    const pending = this.listPending(conversationId)
    await this.repository.cancelQueuedConversationDispatches(conversationId)
    for (const userEntry of pending) {
      await this.repository.updateConversation({ id: userEntry.id, status: "canceled" })
      const responseEntry = this.repository.getConversationByIdempotencyKey(`${userEntry.idempotencyKey}:response`)
      if (responseEntry) {
        await this.repository.updateConversation({
          id: responseEntry.id,
          content: "Canceled before dispatch.",
          status: "canceled"
        })
      }
    }
    return pending.length
  }
}

export class ConversationDispatcher {
  private readonly activeDrains = new Map<string, Promise<void>>()
  private readonly leaseDurationMs = 5 * 60 * 1000
  private readonly lifecycle: ConversationLifecycleService

  constructor(
    private readonly repository: HiveMemoryRepository,
    private readonly dispatch: (input: ConversationDispatchInput) => Promise<ConversationDispatchOutcome>,
    private readonly publishSettledTurn: ConversationTurnPublication = () => undefined
  ) {
    this.lifecycle = new ConversationLifecycleService(repository)
  }

  drain(conversationId: string): Promise<void> {
    const active = this.activeDrains.get(conversationId)
    if (active) return active

    const promise = this.runDrain(conversationId).finally(() => {
      if (this.activeDrains.get(conversationId) === promise) {
        this.activeDrains.delete(conversationId)
      }
    })
    this.activeDrains.set(conversationId, promise)
    return promise
  }

  private async runDrain(conversationId: string) {
    if (isLifecycleOwnedConversationId(conversationId)) {
      await this.runLifecycleDrain(conversationId)
      return
    }
    await this.runLegacyDrain(conversationId)
  }

  private async runLifecycleDrain(conversationId: string) {
    while (true) {
      const claim = await this.lifecycle.claimNextTurn({
        conversationId,
        leaseOwner: this.leaseOwner(conversationId),
        leaseDurationMs: this.leaseDurationMs
      })
      if (!claim) return
      if ("rejected" in claim) continue
      try {
        await this.runLifecycleJob(claim)
      } catch (error) {
        if (this.settlementLeaseWasLost(claim)) continue
        throw error
      }
    }
  }

  private async runLegacyDrain(conversationId: string) {
    while (true) {
      const job = await this.repository.claimNextConversationDispatch({
        conversationId,
        leaseOwner: this.leaseOwner(conversationId),
        leaseDurationMs: this.leaseDurationMs
      })
      if (!job) return
      await this.runLegacyJob(job)
    }
  }

  private async runLegacyJob(job: ExecutionJob) {
    let payload: ReturnType<typeof parseDispatchPayload>
    try {
      payload = parseDispatchPayload(job.payloadJson)
    } catch (error) {
      await this.repository.failExecutionJob({
        id: job.id,
        leaseOwner: job.leaseOwner!,
        error: error instanceof Error ? error.message : String(error)
      }).catch(() => undefined)
      return
    }
    const userEntry = this.repository.getConversationEntry(payload.entryId)
    const responseEntry = payload.responseEntryId
      ? this.repository.getConversationEntry(payload.responseEntryId)
      : undefined
    if (!userEntry) {
      await this.repository.failExecutionJob({
        id: job.id,
        leaseOwner: job.leaseOwner!,
        error: `Conversation entry ${payload.entryId} was not found.`
      })
      return
    }

    await this.repository.updateConversation({ id: userEntry.id, status: "running" })
    if (responseEntry) {
      await this.repository.updateConversation({ id: responseEntry.id, status: "running" })
    }

    let renewalTimer: ReturnType<typeof setInterval> | undefined
    try {
      renewalTimer = setInterval(() => {
        void this.repository.renewExecutionJobLease({
          id: job.id,
          leaseOwner: job.leaseOwner!,
          leaseDurationMs: this.leaseDurationMs
        }).catch(() => undefined)
      }, Math.max(1_000, this.leaseDurationMs / 2))
      const result = await this.dispatch({
        conversationId: payload.conversationId,
        targetAgent: payload.targetAgent,
        content: userEntry.content,
        userEntry,
        responseEntry
      })
      await this.repository.updateConversation({
        id: userEntry.id,
        status: result.status
      })
      if (responseEntry) {
        await this.repository.updateConversation({
          id: responseEntry.id,
          content: result.body,
          status: result.status
        })
      }
      await this.repository.completeExecutionJob({
        id: job.id,
        leaseOwner: job.leaseOwner!,
        result: { status: result.status, responseEntryId: responseEntry?.id ?? null }
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await this.repository.updateConversation({ id: userEntry.id, status: "failed" })
      if (responseEntry) {
        await this.repository.updateConversation({
          id: responseEntry.id,
          content: message,
          status: "failed"
        })
      }
      await this.repository.failExecutionJob({
        id: job.id,
        leaseOwner: job.leaseOwner!,
        error: message
      }).catch(() => undefined)
    } finally {
      if (renewalTimer) clearInterval(renewalTimer)
    }
  }

  private async runLifecycleJob(envelope: TurnDispatchEnvelope) {
    let renewalTimer: ReturnType<typeof setInterval> | undefined
    let outcome: ProviderOutcome
    try {
      renewalTimer = setInterval(() => {
        void this.lifecycle.renewTurnLease({
          jobId: envelope.jobId,
          leaseOwner: envelope.leaseOwner,
          leaseDurationMs: this.leaseDurationMs
        }).catch(() => undefined)
      }, Math.max(1_000, this.leaseDurationMs / 2))
      const result = await this.dispatch(envelope)
      outcome = providerOutcomeFromDispatch(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      outcome = { kind: "failed", body: message, deliveryState: "confirmed" }
    } finally {
      if (renewalTimer) clearInterval(renewalTimer)
    }
    const settled = await this.lifecycle.settleTurn({
      conversationId: envelope.conversationId,
      userEntryId: envelope.userEntryId,
      responseEntryId: envelope.responseEntryId,
      jobId: envelope.jobId,
      idempotencyKey: envelope.idempotencyKey,
      leaseOwner: envelope.leaseOwner,
      outcome
    })
    if (settled.applied) {
      await Promise.resolve(this.publishSettledTurn(settled)).catch(() => undefined)
    }
  }

  private leaseOwner(conversationId: string) {
    return `conversation:${conversationId}:${process.pid}`
  }

  private settlementLeaseWasLost(envelope: TurnDispatchEnvelope) {
    const job = this.repository.getExecutionJob(envelope.jobId)
    if (!job || job.status === "completed" || job.status === "failed" || job.status === "canceled") {
      return true
    }
    if (job.status !== "running" || job.leaseOwner !== envelope.leaseOwner) return true
    return !job.leaseExpiresAt || job.leaseExpiresAt <= new Date().toISOString()
  }
}

function providerOutcomeFromDispatch(result: ConversationDispatchOutcome): ProviderOutcome {
  if (result.status === "failed") {
    return {
      kind: "failed",
      body: result.body,
      deliveryState: result.deliveryState ?? "confirmed"
    }
  }
  return {
    kind: result.status,
    body: result.body,
    deliveryState: "confirmed"
  }
}

function parseDispatchPayload(raw: string) {
  const value = JSON.parse(raw) as Record<string, unknown>
  if (
    typeof value.conversationId !== "string" ||
    typeof value.entryId !== "string" ||
    typeof value.targetAgent !== "string"
  ) {
    throw new Error("Conversation dispatch payload is invalid.")
  }
  return {
    conversationId: value.conversationId,
    entryId: value.entryId,
    responseEntryId: typeof value.responseEntryId === "string" ? value.responseEntryId : undefined,
    targetAgent: value.targetAgent as AgentKind
  }
}
