import assert from "node:assert/strict"
import test from "node:test"
import type {
  NormalizedProviderObservation,
  ProviderObservation,
  TerminalTurnStatus
} from "../lib/conversation-lifecycle/types"
import type { ConversationStatus } from "../lib/hive-memory/types"
import {
  ConversationLifecycleError,
  decideTurnTransition,
  normalizeProviderObservation
} from "../lib/conversation-lifecycle/transitions"

const terminal = ["completed", "interrupted", "canceled", "failed"] as const satisfies ReadonlyArray<TerminalTurnStatus>

const legal = [
  ["queued", "running"],
  ["queued", "canceled"],
  ["queued", "failed"],
  ["running", "completed"],
  ["running", "interrupted"],
  ["running", "canceled"],
  ["running", "failed"]
] as const satisfies ReadonlyArray<readonly [ConversationStatus, ConversationStatus]>

const statusCoverage: Record<ConversationStatus, true> = {
  queued: true,
  running: true,
  completed: true,
  interrupted: true,
  canceled: true,
  failed: true
}

const statuses = Object.keys(statusCoverage) as ConversationStatus[]

function isLegal(source: ConversationStatus, target: ConversationStatus) {
  return legal.some(([from, to]) => from === source && to === target)
}

function isTerminal(status: ConversationStatus) {
  return terminal.includes(status as typeof terminal[number])
}

test("Turn transitions define every source and target contract", () => {
  for (const source of statuses) {
    for (const target of statuses) {
      const label = `${source} -> ${target}`

      if (isLegal(source, target)) {
        assert.deepEqual(decideTurnTransition(source, target), {
          kind: "apply",
          next: target
        }, label)
        continue
      }

      if (source === target) {
        assert.deepEqual(decideTurnTransition(source, target), {
          kind: "noop",
          reason: "duplicate"
        }, label)
        continue
      }

      if (isTerminal(source) && isTerminal(target)) {
        assert.deepEqual(decideTurnTransition(source, target), {
          kind: "noop",
          reason: "terminal"
        }, label)
        continue
      }

      assert.throws(
        () => decideTurnTransition(source, target),
        (error: unknown) =>
          error instanceof ConversationLifecycleError &&
          error.code === "illegal_turn_transition",
        label
      )
    }
  }
})

test("provider observations request only explicit or confirmed terminal Turn outcomes", () => {
  const cases = [
    {
      name: "progress paused",
      observation: {
        kind: "progress",
        providerState: "paused",
        body: "Paused"
      } satisfies ProviderObservation,
      expected: {
        body: "Paused",
        providerState: "paused"
      } satisfies NormalizedProviderObservation
    },
    {
      name: "completed confirmed",
      observation: {
        kind: "completed",
        body: "Completed",
        deliveryState: "confirmed"
      } satisfies ProviderObservation,
      expected: {
        body: "Completed",
        turnTransition: "completed"
      } satisfies NormalizedProviderObservation
    },
    {
      name: "interrupted confirmed",
      observation: {
        kind: "interrupted",
        body: "Interrupted",
        deliveryState: "confirmed"
      } satisfies ProviderObservation,
      expected: {
        body: "Interrupted",
        turnTransition: "interrupted"
      } satisfies NormalizedProviderObservation
    },
    {
      name: "failed confirmed",
      observation: {
        kind: "failed",
        body: "Failed",
        deliveryState: "confirmed"
      } satisfies ProviderObservation,
      expected: {
        body: "Failed",
        turnTransition: "failed"
      } satisfies NormalizedProviderObservation
    },
    {
      name: "failed unknown",
      observation: {
        kind: "failed",
        body: "Unknown failure",
        deliveryState: "unknown"
      } satisfies ProviderObservation,
      expected: {
        body: "Unknown failure"
      } satisfies NormalizedProviderObservation
    },
    {
      name: "explicit stop",
      observation: {
        kind: "stop",
        body: "Stopped"
      } satisfies ProviderObservation,
      expected: {
        body: "Stopped",
        turnTransition: "canceled"
      } satisfies NormalizedProviderObservation
    },
    {
      name: "explicit canceled",
      observation: {
        kind: "canceled",
        body: "Canceled"
      } satisfies ProviderObservation,
      expected: {
        body: "Canceled",
        turnTransition: "canceled"
      } satisfies NormalizedProviderObservation
    }
  ]

  for (const { name, observation, expected } of cases) {
    assert.deepEqual(normalizeProviderObservation(observation), expected, name)
  }
})
