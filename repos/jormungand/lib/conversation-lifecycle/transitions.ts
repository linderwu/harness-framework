import type {
  NormalizedProviderObservation,
  ProviderObservation,
  TerminalTurnStatus,
  TransitionDecision,
  TurnStatus
} from "./types"

const terminalStatuses: Record<TerminalTurnStatus, true> = {
  completed: true,
  interrupted: true,
  canceled: true,
  failed: true
}

const legalTransitions: Record<TurnStatus, readonly TurnStatus[]> = {
  queued: ["running", "canceled", "failed"],
  running: ["completed", "interrupted", "canceled", "failed"],
  completed: [],
  interrupted: [],
  canceled: [],
  failed: []
}

function isTerminalTurnStatus(status: TurnStatus): status is TerminalTurnStatus {
  return status in terminalStatuses
}

export class ConversationLifecycleError extends Error {
  readonly code = "illegal_turn_transition"

  constructor(current: TurnStatus, requested: TurnStatus) {
    super(`Illegal Turn transition: ${current} -> ${requested}`)
    this.name = "ConversationLifecycleError"
  }
}

export function decideTurnTransition(
  current: TurnStatus,
  requested: TurnStatus
): TransitionDecision {
  if (current === requested) {
    return { kind: "noop", reason: "duplicate" }
  }

  if (isTerminalTurnStatus(current) && isTerminalTurnStatus(requested)) {
    return { kind: "noop", reason: "terminal" }
  }

  if (legalTransitions[current].includes(requested)) {
    return { kind: "apply", next: requested }
  }

  throw new ConversationLifecycleError(current, requested)
}

export function normalizeProviderObservation(
  observation: ProviderObservation
): NormalizedProviderObservation {
  if (observation.kind === "progress") {
    return {
      body: observation.body,
      providerState: observation.providerState
    }
  }

  if (observation.kind === "failed" && observation.deliveryState === "unknown") {
    return { body: observation.body }
  }

  return {
    body: observation.body,
    turnTransition: observation.kind === "stop" ? "canceled" : observation.kind
  }
}
