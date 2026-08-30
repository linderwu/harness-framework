import { createConversationId } from "./conversation-identity"
import type { CodexReasoningIntensity } from "./types"
import { CodexConversationError } from "./codex-conversation"
import type { HiveMemoryRepository } from "./hive-memory/repository"
import type {
  ConversationMetadata,
  ConversationState,
  ConversationSummary
} from "./hive-memory/types"

export interface ConversationManagementDependencies {
  repository: HiveMemoryRepository
  stopSession: (conversationId: string) => Promise<void>
  cancelQueuedMessages?: (conversationId: string) => Promise<unknown>
  renameNativeThread?: (conversationId: string, title: string) => Promise<void>
  setNativeThreadState?: (conversationId: string, state: ConversationState) => Promise<void>
  deleteNativeThread?: (conversationId: string) => Promise<void>
}

export class ConversationManagementError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export class ConversationManagementService {
  constructor(private readonly dependencies: ConversationManagementDependencies) {}

  async createConversation(input: { title?: unknown } = {}): Promise<ConversationMetadata> {
    const conversationId = createConversationId()
    return this.dependencies.repository.createConversation({
      id: conversationId,
      title: parseOptionalTitle(input.title) ?? "New conversation"
    })
  }

  listConversations(input: { includeArchived?: boolean } = {}): ConversationSummary[] {
    return this.dependencies.repository.listConversationSummaries(input)
  }

  async updateConversation(input: {
    conversationId: string
    title?: unknown
    state?: unknown
    selectedModelId?: unknown
    selectedReasoningIntensity?: unknown
  }): Promise<ConversationSummary> {
    const metadata = this.requireManagedConversation(input.conversationId)
    const hasTitle = input.title !== undefined
    const hasState = input.state !== undefined
    const hasSelectedModelId = input.selectedModelId !== undefined
    const hasSelectedReasoningIntensity = input.selectedReasoningIntensity !== undefined
    const hasProfile = hasSelectedModelId || hasSelectedReasoningIntensity

    if ([hasTitle, hasState, hasProfile].filter(Boolean).length !== 1) {
      throw new ConversationManagementError(
        "Provide exactly one of title, state, selectedModelId, or selectedReasoningIntensity.",
        400
      )
    }

    if (hasTitle) {
      const title = parseRequiredTitle(input.title)
      await this.dependencies.renameNativeThread?.(metadata.conversationId, title)
      await this.dependencies.repository.renameConversation(metadata.conversationId, title)
      return this.requireConversationSummary(metadata.conversationId)
    }

    if (hasSelectedModelId || hasSelectedReasoningIntensity) {
      await this.dependencies.repository.updateConversationProfile({
        id: metadata.conversationId,
        selectedModelId: hasSelectedModelId
          ? parseSelectedModelId(input.selectedModelId)
          : undefined,
        selectedReasoningIntensity: hasSelectedReasoningIntensity
          ? parseSelectedReasoningIntensity(input.selectedReasoningIntensity)
          : undefined
      })
      return this.requireConversationSummary(metadata.conversationId)
    }

    const nextState = parseConversationState(input.state)
    await this.dependencies.setNativeThreadState?.(metadata.conversationId, nextState)
    await this.dependencies.repository.setConversationState(
      metadata.conversationId,
      nextState
    )
    return this.requireConversationSummary(metadata.conversationId)
  }

  async deleteConversation(input: {
    conversationId: string
    confirm?: unknown
  }): Promise<void> {
    if (input.confirm !== true) {
      throw new ConversationManagementError("confirm:true is required.", 400)
    }

    const metadata = this.requireManagedConversation(input.conversationId)
    await this.dependencies.cancelQueuedMessages?.(metadata.conversationId)

    if (this.dependencies.repository.getCodexSession(metadata.conversationId)) {
      await this.dependencies.deleteNativeThread?.(metadata.conversationId)
      try {
        await this.dependencies.stopSession(metadata.conversationId)
      } catch (error) {
        if (error instanceof CodexConversationError) {
          throw new ConversationManagementError(error.message, error.status)
        }

        throw new ConversationManagementError(
          "Conversation session could not be stopped.",
          502
        )
      }
    }

    await this.dependencies.repository.deleteConversation(metadata.conversationId)
  }

  private requireManagedConversation(conversationId: string): ConversationMetadata {
    if (!isManagedConversationId(conversationId)) {
      throw new ConversationManagementError("Conversation not found.", 404)
    }

    const metadata = this.dependencies.repository.getConversationMetadata(conversationId)
    if (!metadata) {
      throw new ConversationManagementError("Conversation not found.", 404)
    }

    return metadata
  }

  private requireConversationSummary(conversationId: string): ConversationSummary {
    const summary = this.dependencies.repository
      .listConversationSummaries({ includeArchived: true })
      .find((entry) => entry.conversationId === conversationId)

    if (!summary) {
      throw new ConversationManagementError("Conversation not found.", 404)
    }

    return summary
  }
}

export function createConversationManagementService(
  dependencies: ConversationManagementDependencies
) {
  return new ConversationManagementService(dependencies)
}

function isManagedConversationId(value: string) {
  return value.startsWith("conversation:")
}

function parseOptionalTitle(value: unknown) {
  if (value === undefined) {
    return undefined
  }

  return parseRequiredTitle(value)
}

function parseRequiredTitle(value: unknown) {
  if (typeof value !== "string") {
    throw new ConversationManagementError("title must be a string.", 400)
  }

  const normalized = normalizeTitle(value)
  if (!normalized || normalized.length > 80) {
    throw new ConversationManagementError(
      "title must be between 1 and 80 characters.",
      400
    )
  }

  return normalized
}

function parseConversationState(value: unknown): ConversationState {
  if (value !== "active" && value !== "archived") {
    throw new ConversationManagementError(
      "state must be active or archived.",
      400
    )
  }

  return value
}

function parseSelectedModelId(value: unknown): string | null {
  if (value === null) {
    return null
  }

  if (typeof value !== "string") {
    throw new ConversationManagementError(
      "selectedModelId must be null or a string up to 120 characters.",
      400
    )
  }

  const normalized = value.trim()
  if (normalized.length > 120) {
    throw new ConversationManagementError(
      "selectedModelId must be null or a string up to 120 characters.",
      400
    )
  }

  return normalized || null
}

function parseSelectedReasoningIntensity(value: unknown): CodexReasoningIntensity | null {
  if (value === null) return null

  if (value !== "auto" && value !== "low" && value !== "medium" && value !== "high") {
    throw new ConversationManagementError(
      "selectedReasoningIntensity must be null, auto, low, medium, or high.",
      400
    )
  }

  return value
}

function normalizeTitle(value: string) {
  return value.trim().replaceAll(/\s+/g, " ")
}
