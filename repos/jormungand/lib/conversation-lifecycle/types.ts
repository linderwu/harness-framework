import type { AgentKind } from "../types"
import type { ConversationEntry, ConversationStatus } from "../hive-memory/types"
import { legacyConversationId } from "../conversation-identity"

export type TurnStatus = ConversationStatus

export type TerminalTurnStatus =
  | "completed"
  | "interrupted"
  | "canceled"
  | "failed"

export type ProviderOutcome =
  | { kind: "completed"; body: string; deliveryState: "confirmed" }
  | { kind: "interrupted"; body: string; deliveryState: "confirmed" }
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
