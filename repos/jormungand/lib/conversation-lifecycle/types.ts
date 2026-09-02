import type { ConversationStatus } from "../hive-memory/types"

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
