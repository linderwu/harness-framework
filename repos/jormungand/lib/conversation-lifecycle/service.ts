import type { AgentKind } from "../types"
import {
  ConversationTurnRepositoryError,
  type SubmittedConversationTurn,
  type SubmitConversationTurnInput
} from "../hive-memory/repository"
import type { ConversationEntry, ExecutionJobStatus } from "../hive-memory/types"
import type { TurnIdentity } from "./types"

export interface SubmittedTurn extends TurnIdentity {
  readonly userEntry: ConversationEntry
  readonly responseEntry: ConversationEntry
  readonly jobStatus: ExecutionJobStatus
  readonly duplicate: boolean
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
  constructor(private readonly repository: ConversationTurnRepository) {}

  async submitTurn(input: {
    conversationId: string
    targetAgent: AgentKind
    content: unknown
    idempotencyKey: unknown
    responseRole?: unknown
  }): Promise<SubmittedTurn> {
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

    try {
      const submitted = await this.repository.submitConversationTurn({
        conversationId: input.conversationId,
        targetAgent: input.targetAgent,
        content: input.content,
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
