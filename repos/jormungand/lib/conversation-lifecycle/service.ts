import type { AgentKind } from "../types"
import {
  ConversationTurnRepositoryError,
  type SubmittedConversationTurn,
  type SubmitConversationTurnInput
} from "../hive-memory/repository"
import type {
  ConversationEntry,
  ConversationMetadata,
  ExecutionJobStatus
} from "../hive-memory/types"
import type { CodexReasoningIntensity } from "../types"
import type { TurnIdentity } from "./types"

export interface SubmittedTurn extends TurnIdentity {
  readonly userEntry: ConversationEntry
  readonly responseEntry: ConversationEntry
  readonly jobStatus: ExecutionJobStatus
  readonly duplicate: boolean
}

interface ValidatedTurnSubmission {
  readonly content: string
  readonly idempotencyKey: string
  readonly responseRole: "agent" | "manager"
}

export interface ConversationTurnRepository {
  submitConversationTurn(input: SubmitConversationTurnInput): Promise<SubmittedConversationTurn>
}

export type ConversationLifecycleCommandErrorCode =
  | "content_required"
  | "idempotency_key_required"
  | "invalid_idempotency_key"
  | "invalid_response_role"
  | "conversation_not_found"
  | "conversation_not_active"
  | "incomplete_turn_record"
  | "conversation_settings_required"

export class ConversationLifecycleCommandError extends Error {
  constructor(
    readonly code: ConversationLifecycleCommandErrorCode,
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "ConversationLifecycleCommandError"
  }
}

export class ConversationLifecycleService {
  constructor(private readonly repository: ConversationLifecycleRepository) {}

  async openConversation(input: {
    conversationId: string
    title: string
  }): Promise<ConversationMetadata> {
    const existing = this.repository.getConversationMetadata?.(input.conversationId)
    if (existing) return existing
    if (!this.repository.createConversation) {
      throw new Error("Conversation creation is unavailable")
    }
    return await this.repository.createConversation({
      id: input.conversationId,
      title: input.title
    })
  }

  async updateConversationSettings(input: {
    conversationId: string
    selectedModelId?: string | null
    selectedReasoningIntensity?: CodexReasoningIntensity | null
  }): Promise<ConversationMetadata> {
    const metadata = this.repository.getConversationMetadata?.(input.conversationId)
    if (!metadata) {
      throw new ConversationLifecycleCommandError(
        "conversation_not_found",
        404,
        `Conversation ${input.conversationId} was not found.`
      )
    }
    if (metadata.state !== "active") {
      throw new ConversationLifecycleCommandError(
        "conversation_not_active",
        409,
        `Conversation ${input.conversationId} is not active.`
      )
    }
    if (input.selectedModelId === undefined && input.selectedReasoningIntensity === undefined) {
      throw new ConversationLifecycleCommandError(
        "conversation_settings_required",
        400,
        "At least one conversation setting is required."
      )
    }
    if (!this.repository.updateConversationProfile) {
      throw new Error("Conversation settings are unavailable")
    }
    return await this.repository.updateConversationProfile({
      id: input.conversationId,
      selectedModelId: input.selectedModelId,
      selectedReasoningIntensity: input.selectedReasoningIntensity
    })
  }

  validateSubmitTurn(input: {
    content: unknown
    idempotencyKey: unknown
    responseRole?: unknown
  }): ValidatedTurnSubmission {
    if (typeof input.content !== "string" || !input.content.trim()) {
      throw new ConversationLifecycleCommandError("content_required", 400, "content is required")
    }
    if (typeof input.idempotencyKey !== "string" || !input.idempotencyKey.trim()) {
      throw new ConversationLifecycleCommandError("idempotency_key_required", 400, "idempotencyKey is required")
    }
    const idempotencyKey = input.idempotencyKey.trim()
    if (!isWellFormedUtf16(idempotencyKey)) {
      throw new ConversationLifecycleCommandError(
        "invalid_idempotency_key",
        400,
        "idempotencyKey is invalid"
      )
    }
    const responseRole = input.responseRole === undefined ? "agent" : input.responseRole
    if (responseRole !== "agent" && responseRole !== "manager") {
      throw new ConversationLifecycleCommandError(
        "invalid_response_role",
        400,
        "responseRole must be agent or manager"
      )
    }
    return { content: input.content, idempotencyKey, responseRole }
  }

  async submitTurn(input: {
    conversationId: string
    targetAgent: AgentKind
    content: unknown
    idempotencyKey: unknown
    responseRole?: unknown
  }): Promise<SubmittedTurn> {
    const { content, idempotencyKey, responseRole } = this.validateSubmitTurn(input)

    try {
      const submitted = await this.repository.submitConversationTurn({
        conversationId: input.conversationId,
        targetAgent: input.targetAgent,
        content,
        idempotencyKey,
        responseRole
      })
      return {
        conversationId: submitted.conversationId,
        userEntryId: submitted.userEntryId,
        responseEntryId: submitted.responseEntryId,
        jobId: submitted.jobId,
        idempotencyKey: submitted.idempotencyKey,
        userEntry: submitted.userEntry,
        responseEntry: submitted.responseEntry,
        jobStatus: submitted.jobStatus,
        duplicate: submitted.duplicate
      }
    } catch (error) {
      if (error instanceof ConversationTurnRepositoryError) {
        throw commandErrorFromRepository(error)
      }
      throw error
    }
  }
}

interface ConversationLifecycleRepository extends ConversationTurnRepository {
  getConversationMetadata?: (conversationId: string) => ConversationMetadata | undefined
  createConversation?: (input: { id: string; title: string }) => Promise<ConversationMetadata>
  updateConversationProfile?: (input: {
    id: string
    selectedModelId?: string | null
    selectedReasoningIntensity?: CodexReasoningIntensity | null
  }) => Promise<ConversationMetadata>
}

function commandErrorFromRepository(
  error: ConversationTurnRepositoryError
): ConversationLifecycleCommandError {
  switch (error.code) {
    case "invalid_idempotency_key":
      return new ConversationLifecycleCommandError(error.code, 400, error.message)
    case "conversation_not_found":
      return new ConversationLifecycleCommandError(error.code, 404, error.message)
    case "conversation_not_active":
    case "incomplete_turn_record":
      return new ConversationLifecycleCommandError(error.code, 409, error.message)
  }
}

function isWellFormedUtf16(value: string) {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index)
    if (codeUnit >= 0xD800 && codeUnit <= 0xDBFF) {
      const nextCodeUnit = value.charCodeAt(index + 1)
      if (nextCodeUnit >= 0xDC00 && nextCodeUnit <= 0xDFFF) {
        index += 1
        continue
      }
      return false
    }
    if (codeUnit >= 0xDC00 && codeUnit <= 0xDFFF) {
      return false
    }
  }
  return true
}
