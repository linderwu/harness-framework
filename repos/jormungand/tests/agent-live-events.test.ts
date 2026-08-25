import assert from "node:assert/strict"
import test from "node:test"

import {
  extractReasoningText,
  MAX_AGENT_LIVE_TEXT,
  normalizeAgentLiveEvent
} from "../lib/agent-live-events"

test("normalizes a provider reasoning frame without exposing arbitrary fields", () => {
  const event = normalizeAgentLiveEvent({
    sequence: 4,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "reasoning",
    text: "Checking the repository",
    metadata: { secret: "must-not-survive" }
  })

  assert.deepEqual(
    {
      sequence: event.sequence,
      conversationId: event.conversationId,
      agentId: event.agentId,
      type: event.type,
      text: event.text,
      metadata: event.metadata
    },
    {
      sequence: 4,
      conversationId: "conversation-1",
      agentId: "openclaw.rowlet",
      type: "reasoning",
      text: "Checking the repository",
      metadata: undefined
    }
  )
  assert.match(event.id, /\S/)
  assert.match(event.createdAt, /^\d{4}-\d{2}-\d{2}T/)
})

test("extracts only explicit closed reasoning blocks", () => {
  assert.equal(extractReasoningText({ reasoning: "structured" }), "structured")
  assert.equal(extractReasoningText({ thinking: "thought" }), "thought")
  assert.equal(extractReasoningText({ reasoning_content: "content" }), "content")
  assert.equal(extractReasoningText({ text: "<think>inline</think>answer" }), "inline")
  assert.equal(extractReasoningText({ text: "ordinary log output" }), undefined)
  assert.equal(extractReasoningText({ text: "<think>missing close" }), undefined)
})

test("bounds event text and rejects invalid identity", () => {
  assert.throws(() =>
    normalizeAgentLiveEvent({ conversationId: "", agentId: "codex", type: "status" })
  )
  assert.throws(() =>
    normalizeAgentLiveEvent({ conversationId: "conversation-1", agentId: "", type: "status" })
  )

  const event = normalizeAgentLiveEvent({
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "status",
    message: "x".repeat(20_000)
  })

  assert.equal(event.message?.length, MAX_AGENT_LIVE_TEXT)
})

test("keeps bounded OpenClaw response details without returning the final visible text", () => {
  const event = normalizeAgentLiveEvent({
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "completed",
    details: {
      finalAssistantVisibleText: "must stay in the conversation",
      finalAssistantRawText: "raw answer",
      executionTrace: { winnerModel: "MiniMax-M2.7" }
    }
  })
  const details = (event as typeof event & {
    details?: Record<string, unknown>
  }).details

  assert.equal(details?.finalAssistantVisibleText, undefined)
  assert.equal(details?.finalAssistantRawText, "raw answer")

  const boundedEvent = normalizeAgentLiveEvent({
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "completed",
    details: { oversized: "x".repeat(70_000) }
  })
  const boundedDetails = (boundedEvent as typeof boundedEvent & {
    details?: Record<string, unknown>
  }).details
  assert.equal(boundedDetails?.truncated, true)
})

test("preserves non-empty assistant delta whitespace across message text and delta while still bounding it", () => {
  const leadingSpace = normalizeAgentLiveEvent({
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "assistant_delta",
    delta: " hello"
  })
  const textLeadingSpace = normalizeAgentLiveEvent({
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "assistant_delta",
    text: " hello "
  })
  const messageNewline = normalizeAgentLiveEvent({
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "assistant_delta",
    message: "\n"
  })
  const newline = normalizeAgentLiveEvent({
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "assistant_delta",
    delta: "\n"
  })

  assert.equal(leadingSpace.delta, " hello")
  assert.equal(textLeadingSpace.text, " hello ")
  assert.equal(messageNewline.message, "\n")
  assert.equal(newline.delta, "\n")
})

test("rejects unsupported live event types", () => {
  assert.throws(() =>
    normalizeAgentLiveEvent({
      conversationId: "conversation-1",
      agentId: "openclaw.rowlet",
      type: "unknown"
    })
  )
})
