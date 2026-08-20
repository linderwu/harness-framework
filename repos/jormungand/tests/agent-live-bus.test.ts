import assert from "node:assert/strict"
import test from "node:test"

import type { AgentLiveEvent, AgentLiveEventType } from "../lib/agent-live-events"
import { createAgentLiveBus } from "../lib/agent-live-bus"

function createEvent(
  type: AgentLiveEventType,
  sequence: number,
  conversationId = "conversation-1"
): AgentLiveEvent {
  return {
    id: `${conversationId}-${sequence}`,
    sequence,
    conversationId,
    agentId: "openclaw.rowlet",
    type,
    createdAt: new Date(sequence * 1_000).toISOString(),
    message: `${type}-${sequence}`
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

test("idle cleanup timer is unrefed when the runtime supports it", () => {
  const originalSetTimeout = globalThis.setTimeout
  let unrefCalled = false

  const timeoutMock = (((callback: TimerHandler, _delay?: number) => ({
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
