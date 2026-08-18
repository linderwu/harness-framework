import assert from "node:assert/strict"
import test from "node:test"

import {
  buildSharedConversationHistory,
  formatSharedConversationPrompt,
  sharedConversationEntryCharacterLimit,
  sharedConversationHistoryLimit
} from "../lib/conversation-history"
import type { ConversationEntry } from "../lib/hive-memory/types"

function makeEntry(input: {
  id: string
  role: ConversationEntry["role"]
  content: string
  agentId?: ConversationEntry["agentId"]
}): Pick<ConversationEntry, "id" | "role" | "agentId" | "content"> {
  return input
}

test("buildSharedConversationHistory keeps the latest 20 shareable entries in order", () => {
  const longContent = `  ${"x".repeat(1500)}\n\n${"y".repeat(200)}  `
  const entries: Array<Pick<ConversationEntry, "id" | "role" | "agentId" | "content">> = [
    makeEntry({
      id: "0",
      role: "user",
      content: "drop-me-first"
    }),
    makeEntry({
      id: "1",
      role: "system",
      content: "drop-system-1"
    }),
    makeEntry({
      id: "2",
      role: "agent",
      agentId: "openclaw.rowlet",
      content: "  first \n shared\tentry  "
    }),
    makeEntry({
      id: "3",
      role: "manager",
      content: "manager update"
    }),
    makeEntry({
      id: "4",
      role: "system",
      content: "drop-system-2"
    }),
    makeEntry({
      id: "5",
      role: "user",
      content: "user message 5"
    }),
    makeEntry({
      id: "6",
      role: "agent",
      agentId: "openclaw.gengar",
      content: "agent message 6"
    }),
    makeEntry({
      id: "7",
      role: "manager",
      content: "manager message 7"
    }),
    makeEntry({
      id: "8",
      role: "user",
      content: "user message 8"
    }),
    makeEntry({
      id: "9",
      role: "system",
      content: "drop-system-3"
    }),
    makeEntry({
      id: "10",
      role: "agent",
      agentId: "openclaw.rowlet",
      content: "agent message 10"
    }),
    makeEntry({
      id: "11",
      role: "manager",
      content: "manager message 11"
    }),
    makeEntry({
      id: "12",
      role: "user",
      content: "user message 12"
    }),
    makeEntry({
      id: "13",
      role: "agent",
      agentId: "openclaw.gengar",
      content: "agent message 13"
    }),
    makeEntry({
      id: "14",
      role: "manager",
      content: "manager message 14"
    }),
    makeEntry({
      id: "15",
      role: "user",
      content: "user message 15"
    }),
    makeEntry({
      id: "16",
      role: "agent",
      agentId: "openclaw.rowlet",
      content: "agent message 16"
    }),
    makeEntry({
      id: "17",
      role: "manager",
      content: "manager message 17"
    }),
    makeEntry({
      id: "18",
      role: "user",
      content: "user message 18"
    }),
    makeEntry({
      id: "19",
      role: "agent",
      agentId: "openclaw.gengar",
      content: "agent message 19"
    }),
    makeEntry({
      id: "20",
      role: "manager",
      content: "manager message 20"
    }),
    makeEntry({
      id: "21",
      role: "user",
      content: "user message 21"
    }),
    makeEntry({
      id: "22",
      role: "agent",
      agentId: "openclaw.rowlet",
      content: "agent message 22"
    }),
    makeEntry({
      id: "23",
      role: "manager",
      agentId: "openclaw.gengar",
      content: longContent
    })
  ]

  const history = buildSharedConversationHistory(entries)

  assert.equal(history.length, sharedConversationHistoryLimit)
  assert.deepEqual(history[0], {
    role: "assistant",
    content: "[openclaw.rowlet] first shared entry"
  })
  assert.deepEqual(history[1], {
    role: "assistant",
    content: "[manager] manager update"
  })
  assert.deepEqual(history[2], {
    role: "user",
    content: "[user] user message 5"
  })
  assert.deepEqual(history[3], {
    role: "assistant",
    content: "[openclaw.gengar] agent message 6"
  })
  assert.equal(
    history.some((entry: { role: "user" | "assistant"; content: string }) =>
      entry.content.includes("drop-me-first")
    ),
    false
  )
  assert.equal(
    history.some((entry: { role: "user" | "assistant"; content: string }) =>
      entry.content.includes("drop-system")
    ),
    false
  )
  assert.equal(history.at(-1)?.role, "assistant")
  assert.ok(history.at(-1)?.content.startsWith("[openclaw.gengar] "))
  assert.equal(history.at(-1)?.content.length, sharedConversationEntryCharacterLimit)
})

test("formatSharedConversationPrompt marks shared transcript as untrusted and points to the latest operator message", () => {
  const prompt = formatSharedConversationPrompt([
    { role: "user", content: "[user] Need the latest status." },
    { role: "assistant", content: "[openclaw.rowlet] Current status is pending." }
  ])

  assert.match(prompt, /BEGIN UNTRUSTED SHARED TRANSCRIPT/)
  assert.match(prompt, /END UNTRUSTED SHARED TRANSCRIPT/)
  assert.match(prompt, /Respond to the latest operator message\./)
  assert.match(prompt, /user: \[user\] Need the latest status\./)
  assert.match(prompt, /assistant: \[openclaw\.rowlet\] Current status is pending\./)
})
