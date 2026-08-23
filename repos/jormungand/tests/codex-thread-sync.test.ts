import assert from "node:assert/strict"
import test from "node:test"
import { projectNativeThread, type NativeTurn } from "../lib/codex-thread-sync"

const harnessOriginatedTurn: NativeTurn = {
  id: "turn-harness",
  status: "completed",
  items: [
    {
      id: "item-harness-user",
      type: "userMessage",
      content: [{ type: "text", text: "[shared Harness context] first prompt" }]
    },
    {
      id: "item-harness-agent",
      type: "agentMessage",
      text: "Codex reply",
      phase: "final_answer"
    }
  ]
}

const codexDesktopTurn: NativeTurn = {
  id: "turn-desktop",
  status: "completed",
  items: [
    {
      id: "item-desktop-user",
      type: "userMessage",
      content: [{ type: "text", text: "message from Codex desktop" }]
    },
    {
      id: "item-desktop-agent",
      type: "agentMessage",
      text: "desktop response",
      phase: "final_answer"
    }
  ]
}

test("does not import Harness-originated synthetic context as a second user entry", () => {
  const result = projectNativeThread({
    conversationId: "conversation:projection",
    nativeThreadId: "thread-1",
    turns: [harnessOriginatedTurn],
    harnessTurnIds: new Set(["turn-harness"]),
    ledgerKeys: new Set()
  })

  assert.deepEqual(result.entries.map((entry) => entry.content), ["Codex reply"])
  assert.equal(result.entries[0]?.source, "harness")
})

test("imports an unknown Codex desktop turn with stable native idempotency", () => {
  const result = projectNativeThread({
    conversationId: "conversation:projection",
    nativeThreadId: "thread-1",
    turns: [codexDesktopTurn],
    harnessTurnIds: new Set(),
    ledgerKeys: new Set()
  })

  assert.equal(result.entries[0]?.content, "message from Codex desktop")
  assert.equal(result.entries[0]?.idempotencyKey, "codex:thread-1:turn-desktop:item-desktop-user")
  assert.equal(result.entries[1]?.content, "desktop response")
  assert.equal(result.entries[1]?.replyToNativeTurnId, "turn-desktop")
})

test("preserves native order and omits already ledgered items", () => {
  const result = projectNativeThread({
    conversationId: "conversation:projection",
    nativeThreadId: "thread-1",
    turns: [codexDesktopTurn, { ...harnessOriginatedTurn, id: "turn-later" }],
    harnessTurnIds: new Set(["turn-later"]),
    ledgerKeys: new Set(["thread-1:turn-desktop:item-desktop-user"])
  })

  assert.deepEqual(result.entries.map((entry) => entry.content), ["desktop response", "Codex reply"])
  assert.deepEqual(result.entries.map((entry) => entry.nativeItemId), [
    "item-desktop-agent",
    "item-harness-agent"
  ])
})

test("returns terminal native turn status for Harness state reconciliation", () => {
  const result = projectNativeThread({
    conversationId: "conversation:projection",
    nativeThreadId: "thread-1",
    turns: [{ ...codexDesktopTurn, id: "turn-failed", status: "failed" }],
    harnessTurnIds: new Set(),
    ledgerKeys: new Set()
  })

  assert.equal(result.terminalStatus, "failed")
})
