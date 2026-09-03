import { createConversationId } from "./conversation-identity"
import {
  ConversationLifecycleCommandError,
  type ConversationLifecycleService
} from "./conversation-lifecycle/service"
import type { HiveMemoryRepository } from "./hive-memory/repository"
import type {
  ConversationMetadata,
  ConversationState,
  ConversationSummary
} from "./hive-memory/types"

export interface ConversationManagementDependencies {
  repository: HiveMemoryRepository
  lifecycle: ConversationManagementLifecycle
  stopSession: (conversationId: string) => Promise<void>
  renameNativeThread?: (conversationId: string, title: string) => Promise<void>
  setNativeThreadState?: (conversationId: string, state: ConversationState) => Promise<void>
  deleteNativeThread?: (conversationId: string) => Promise<void>
}

export type ConversationManagementLifecycle = Pick<
  ConversationLifecycleService,
  | "validateConversationTitle"
  | "validateConversationState"
  | "createConversation"
  | "updateConversationSettings"
  | "renameConversation"
  | "setConversationState"
  | "cancelPendingTurns"
  | "deleteConversation"
>

export class ConversationManagementError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

export class ConversationManagementService {
  constructor(private readonly dependencies: ConversationManagementDependencies) {}

  async createConversation(input: { title?: unknown } = {}): Promise<ConversationMetadata> {
    const conversationId = createConversationId()
    return await this.runLifecycleCommand(() =>
      this.dependencies.lifecycle.createConversation({
        conversationId,
        title: input.title === undefined ? "New conversation" : input.title
      })
    )
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
      const title = await this.runLifecycleCommand(() =>
        this.dependencies.lifecycle.validateConversationTitle(input.title)
      )
      await this.dependencies.renameNativeThread?.(metadata.conversationId, title)
      await this.runLifecycleCommand(() =>
        this.dependencies.lifecycle.renameConversation({
          conversationId: metadata.conversationId,
          title
        })
      )
      return this.requireConversationSummary(metadata.conversationId)
    }

    if (hasSelectedModelId || hasSelectedReasoningIntensity) {
      await this.runLifecycleCommand(() =>
        this.dependencies.lifecycle.updateConversationSettings({
          conversationId: metadata.conversationId,
          selectedModelId: hasSelectedModelId ? input.selectedModelId : undefined,
          selectedReasoningIntensity: hasSelectedReasoningIntensity
            ? input.selectedReasoningIntensity
            : undefined
        })
      )
      return this.requireConversationSummary(metadata.conversationId)
    }

    const nextState = await this.runLifecycleCommand(() =>
      this.dependencies.lifecycle.validateConversationState(input.state)
    )
    await this.dependencies.setNativeThreadState?.(metadata.conversationId, nextState)
    await this.runLifecycleCommand(() =>
      this.dependencies.lifecycle.setConversationState({
        conversationId: metadata.conversationId,
        state: nextState
      })
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
    await this.runLifecycleCommand(() =>
      this.dependencies.lifecycle.cancelPendingTurns(metadata.conversationId)
    )

    if (this.dependencies.repository.getCodexSession(metadata.conversationId)) {
      await this.dependencies.deleteNativeThread?.(metadata.conversationId)
      try {
        await this.dependencies.stopSession(metadata.conversationId)
      } catch (error) {
        if (isStopSessionStatusError(error)) {
          throw new ConversationManagementError(error.message, error.status)
        }

        throw new ConversationManagementError(
          "Conversation session could not be stopped.",
          502
        )
      }
    }

    await this.runLifecycleCommand(() =>
      this.dependencies.lifecycle.deleteConversation({ conversationId: metadata.conversationId })
    )
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

  private async runLifecycleCommand<T>(command: () => T | Promise<T>): Promise<T> {
    try {
      return await command()
    } catch (error) {
      if (isConversationLifecycleCommandError(error)) {
        throw new ConversationManagementError(error.message, error.status)
      }
      throw error
    }
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

function isStopSessionStatusError(
  error: unknown
): error is { message: string; status: number } {
  if (typeof error !== "object" || error === null) return false
  if (!("message" in error) || typeof error.message !== "string") return false
  if (!("status" in error) || typeof error.status !== "number") return false
  return Number.isFinite(error.status) &&
    Number.isInteger(error.status) &&
    error.status >= 400 &&
    error.status <= 599
}

function isConversationLifecycleCommandError(
  error: unknown
): error is ConversationLifecycleCommandError {
  return error instanceof ConversationLifecycleCommandError || (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    "message" in error &&
    "status" in error &&
    error.name === "ConversationLifecycleCommandError" &&
    typeof error.message === "string" &&
    typeof error.status === "number"
  )
}
