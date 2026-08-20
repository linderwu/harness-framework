import assert from "node:assert/strict"
import test from "node:test"

import type { AgentLiveEvent, AgentLiveEventType } from "../lib/agent-live-events"
import { createAgentLiveBus } from "../lib/agent-live-bus"

function createEvent(
  type: AgentLiveEventType,
  sequence: number,
  conversationId = "conversation-1",
  metadata?: AgentLiveEvent["metadata"]
): AgentLiveEvent {
  return {
    id: `${conversationId}-${sequence}`,
    sequence,
    conversationId,
    agentId: "openclaw.rowlet",
    type,
    createdAt: new Date(sequence * 1_000).toISOString(),
    message: `${type}-${sequence}`,
    metadata
  }
}

test("replays only bounded recent window and sequence order with maxEvents 2", () => {
  const bus = createAgentLiveBus({ maxEvents: 2 })

  bus.publish(createEvent("status", 1))
  bus.publish(createEvent("status", 2))
  bus.publish(createEvent("status", 3))
  bus.publish(createEvent("status", 2))

  assert.deepEqual(
    bus.getSnapshot("conversation-1").events.map((event) => event.sequence),
    [2, 3]
  )
})

test("unsubscribe stops future delivery and terminal events close stream", () => {
  const bus = createAgentLiveBus()
  const received: AgentLiveEvent[] = []

  const subscription = bus.subscribe("conversation-1", (event) => {
    received.push(event)
  })

  bus.publish(createEvent("started", 1))
  subscription.unsubscribe()
  bus.publish(createEvent("completed", 2))

  assert.deepEqual(received.map((event) => event.sequence), [1])
  assert.equal(bus.getSnapshot("conversation-1").terminal, true)
})

test("terminal state stays sticky after a later nonterminal event", () => {
  const bus = createAgentLiveBus()

  bus.publish(createEvent("completed", 2))
  bus.publish(createEvent("status", 3))

  const snapshot = bus.getSnapshot("conversation-1")
  assert.equal(snapshot.terminal, true)
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [2, 3])
})

test("terminal state stays sticky for later events from the same run", () => {
  const bus = createAgentLiveBus()

  bus.publish(createEvent("started", 1, "conversation-1", { runId: "run-1" }))
  bus.publish(createEvent("completed", 2, "conversation-1", { runId: "run-1" }))
  bus.publish(createEvent("status", 3, "conversation-1", { runId: "run-1" }))

  const snapshot = bus.getSnapshot("conversation-1")
  assert.equal(snapshot.terminal, true)
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [1, 2, 3])
})

test("a new started event opens a fresh lifecycle for subscribers after a terminal run", () => {
  const bus = createAgentLiveBus()
  const received: AgentLiveEvent[] = []

  bus.publish(createEvent("started", 1, "conversation-1", { runId: "run-1" }))
  bus.publish(createEvent("completed", 2, "conversation-1", { runId: "run-1" }))

  const subscription = bus.subscribe("conversation-1", (event) => {
    received.push(event)
  })

  bus.publish(createEvent("started", 3, "conversation-1", { runId: "run-2" }))
  bus.publish(createEvent("status", 4, "conversation-1", { runId: "run-2" }))
  subscription.unsubscribe()

  const snapshot = bus.getSnapshot("conversation-1")
  assert.equal(snapshot.terminal, false)
  assert.deepEqual(received.map((event) => event.sequence), [3, 4])
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [1, 2, 3, 4])
})

test("started without a runId still opens a new lifecycle after a terminal snapshot", () => {
  const bus = createAgentLiveBus()

  bus.publish(createEvent("completed", 2, "conversation-1", { runId: "run-1" }))
  bus.publish(createEvent("started", 3))

  const snapshot = bus.getSnapshot("conversation-1")
  assert.equal(snapshot.terminal, false)
  assert.deepEqual(snapshot.events.map((event) => event.sequence), [2, 3])
})

test("idle cleanup timer is unrefed when the runtime supports it", () => {
  const originalSetTimeout = globalThis.setTimeout
  let unrefCalled = false

  const timeoutMock = (((callback: TimerHandler) => ({
    callback,
    unref() {
      unrefCalled = true
      return this
    }
  })) as unknown) as typeof setTimeout

  globalThis.setTimeout = timeoutMock

  try {
    const bus = createAgentLiveBus()
    const subscription = bus.subscribe("conversation-1", () => undefined)
    subscription.unsubscribe()
  } finally {
    globalThis.setTimeout = originalSetTimeout
  }

  assert.equal(unrefCalled, true)
})
