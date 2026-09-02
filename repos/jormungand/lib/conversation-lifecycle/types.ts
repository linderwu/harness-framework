import type { AgentKind } from "../types"
import type { ConversationEntry, ConversationStatus, ExecutionJob } from "../hive-memory/types"
import { legacyConversationId } from "../conversation-identity"

export type TurnStatus = ConversationStatus

export type TerminalTurnStatus =
  | "completed"
  | "interrupted"
  | "canceled"
  | "failed"

export type ProviderOutcome =
  | { kind: "completed"; body: string; deliveryState: "confirmed" }
  | { kind: "interrupted"; body: string; deliveryState: "confirmed"; disposition?: "stopped" }
  | { kind: "failed"; body: string; deliveryState: "confirmed" | "unknown" }

export interface TurnIdentity {
  conversationId: string
  userEntryId: string
  responseEntryId: string
  jobId: string
  idempotencyKey: string
}

export interface TurnDispatchEnvelope extends TurnIdentity {
  readonly leaseOwner: string
  readonly leaseExpiresAt: string
  readonly attemptCount: number
  readonly targetAgent: AgentKind
  readonly content: string
  readonly userEntry: ConversationEntry
  readonly responseEntry: ConversationEntry
}

export interface SettleTurnInput extends TurnIdentity {
  readonly leaseOwner: string
  readonly outcome: ProviderOutcome
  readonly now?: string
}

export interface SettledTurnAggregate extends TurnIdentity {
  readonly applied: boolean
  readonly userEntry: ConversationEntry
  readonly responseEntry: ConversationEntry
  readonly job: ExecutionJob
}

export interface TurnSnapshot {
  readonly userEntry: ConversationEntry
  readonly responseEntry: ConversationEntry
}

export interface RecordTurnProgressInput {
  readonly conversationId: string
  readonly userEntryId: string
  readonly responseEntryId: string
  readonly body: string
}

export interface ReconcileProviderEntryInput {
  readonly conversationId: string
  readonly role: "user" | "agent"
  readonly content: string
  readonly status: ConversationStatus
  readonly idempotencyKey: string
  readonly replyToId?: string
  readonly replaceEntryId?: string
}

/**
 * Runtime-neutral authority for core Conversation Entry mutations.
 *
 * `reconcileProviderEntry` is intentionally the sole no-Execution-Job path:
 * it imports idempotent provider-originated native history into an active,
 * unbound Conversation and must never fabricate a dispatch job.
 */
export interface ConversationLifecyclePort {
  recordTurnProgress(input: RecordTurnProgressInput): Promise<TurnSnapshot>
  settleTurn(input: SettleTurnInput): Promise<SettledTurnAggregate>
  reconcileProviderEntry(input: ReconcileProviderEntryInput): Promise<ConversationEntry>
  coalesceProviderEntries(input: {
    preferredId: string
    duplicateId: string
  }): Promise<void>
}

export type TurnClaimResult = TurnDispatchEnvelope | {
  readonly rejected: true
  readonly jobId: string
  readonly error: string
}

export function isLifecycleOwnedConversationId(conversationId: string) {
  return conversationId.startsWith("conversation:") || conversationId === legacyConversationId
}

export type TransitionDecision =
  | { kind: "apply"; next: TurnStatus }
  | { kind: "noop"; reason: "duplicate" | "terminal" }

export type ProviderObservation =
  | { kind: "progress"; providerState: string; body: string }
  | { kind: "stop"; body: string }
  | { kind: "canceled"; body: string }
  | ProviderOutcome

export interface NormalizedProviderObservation {
  body: string
  providerState?: string
  turnTransition?: TerminalTurnStatus
}
