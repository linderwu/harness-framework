import assert from "node:assert/strict"
import test from "node:test"

import { buildSharedConversationHistory, sharedConversationHistoryLimit } from "../lib/conversation-history"
import { ConversationHistorySync } from "../lib/conversation-history-sync"
import type { ConversationEntry } from "../lib/hive-memory/types"

function makeEntry(input: {
  id: string
  role: ConversationEntry["role"]
  content: string
  agentId?: ConversationEntry["agentId"]
}): Pick<ConversationEntry, "id" | "role" | "agentId" | "content"> {
  return input
}

test("initial seed latest20", () => {
  const sync = new ConversationHistorySync()
  const entries = Array.from({ length: 25 }, (_, index) =>
    makeEntry({
      id: `entry-${index + 1}`,
      role: index % 3 === 0 ? "user" : index % 3 === 1 ? "agent" : "manager",
      agentId: index % 3 === 1 ? "openclaw.gengar" : undefined,
      content: `message ${index + 1}`
    })
  )

  const result = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries
  })

  assert.equal(result.history.length, sharedConversationHistoryLimit)
  assert.deepEqual(result.history, buildSharedConversationHistory(entries))
  assert.equal(result.cursorEntryId, "entry-25")
})

test("same session only new delta", () => {
  const sync = new ConversationHistorySync()
  const initialEntries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" }),
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.gengar", content: "agent 2" }),
    makeEntry({ id: "entry-3", role: "manager", content: "manager 3" })
  ]
  const initialResult = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries: initialEntries
  })

  sync.markDelivered({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    cursorEntryId: initialResult.cursorEntryId
  })

  const nextEntries = [
    ...initialEntries,
    makeEntry({ id: "entry-4", role: "system", content: "system 4" }),
    makeEntry({ id: "entry-5", role: "user", content: "user 5" }),
    makeEntry({ id: "entry-6", role: "agent", agentId: "openclaw.gengar", content: "agent 6" }),
    makeEntry({ id: "entry-7", role: "manager", content: "manager 7" })
  ]

  const result = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries: nextEntries
  })

  assert.deepEqual(
    result.history,
    buildSharedConversationHistory(nextEntries.slice(4))
  )
  assert.equal(result.cursorEntryId, "entry-7")
})

test("self response excluded but cursor advances", () => {
  const sync = new ConversationHistorySync()
  const initialEntries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" })
  ]
  const initialResult = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries: initialEntries
  })

  sync.markDelivered({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    cursorEntryId: initialResult.cursorEntryId
  })

  const nextEntries = [
    ...initialEntries,
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.gengar", content: "agent 2" }),
    makeEntry({ id: "entry-3", role: "agent", agentId: "openclaw.rowlet", content: "self agent 3" }),
    makeEntry({ id: "entry-4", role: "manager", agentId: "openclaw.rowlet", content: "self manager 4" })
  ]

  const result = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries: nextEntries
  })

  assert.deepEqual(
    result.history,
    buildSharedConversationHistory([nextEntries[1]])
  )
  assert.equal(result.cursorEntryId, "entry-4")
})

test("changed session reseeds", () => {
  const sync = new ConversationHistorySync()
  const firstSessionEntries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" }),
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.gengar", content: "agent 2" })
  ]
  const firstSessionResult = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries: firstSessionEntries
  })

  sync.markDelivered({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    cursorEntryId: firstSessionResult.cursorEntryId
  })

  const secondSessionEntries = Array.from({ length: 22 }, (_, index) =>
    makeEntry({
      id: `entry-${index + 10}`,
      role: index % 2 === 0 ? "user" : "agent",
      agentId: index % 2 === 1 ? "openclaw.gengar" : undefined,
      content: `session 2 message ${index + 1}`
    })
  )

  const result = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-2",
    targetAgent: "openclaw.rowlet",
    entries: secondSessionEntries
  })

  assert.equal(result.history.length, sharedConversationHistoryLimit)
  assert.deepEqual(result.history, buildSharedConversationHistory(secondSessionEntries))
  assert.equal(result.cursorEntryId, "entry-31")
})

test("separate keys isolate", () => {
  const sync = new ConversationHistorySync()
  const initialEntries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" })
  ]
  const initialResult = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries: initialEntries
  })

  sync.markDelivered({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    cursorEntryId: initialResult.cursorEntryId
  })

  const nextEntries = [
    ...initialEntries,
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.gengar", content: "agent 2" })
  ]

  const result = sync.getDelta({
    key: "conversation-b",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries: nextEntries
  })

  assert.deepEqual(result.history, buildSharedConversationHistory(nextEntries))
  assert.equal(result.cursorEntryId, "entry-2")
})

test("delimiter-containing key and sessionIdentity values remain isolated", () => {
  const sync = new ConversationHistorySync()
  const firstEntries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" }),
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.gengar", content: "agent 2" })
  ]
  const firstResult = sync.getDelta({
    key: "conversation::a",
    sessionIdentity: "session-b",
    targetAgent: "openclaw.rowlet",
    entries: firstEntries
  })

  sync.markDelivered({
    key: "conversation::a",
    sessionIdentity: "session-b",
    cursorEntryId: firstResult.cursorEntryId
  })

  const secondEntries = [
    ...firstEntries,
    makeEntry({ id: "entry-3", role: "user", content: "user 3" })
  ]

  const result = sync.getDelta({
    key: "conversation",
    sessionIdentity: "a::session-b",
    targetAgent: "openclaw.rowlet",
    entries: secondEntries
  })

  assert.deepEqual(result.history, buildSharedConversationHistory(secondEntries))
  assert.equal(result.cursorEntryId, "entry-3")
})

test("consecutive getDelta calls without markDelivered return identical results", () => {
  const sync = new ConversationHistorySync()
  const entries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" }),
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.gengar", content: "agent 2" })
  ]

  const firstResult = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries
  })

  const secondResult = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries
  })

  assert.deepEqual(secondResult, firstResult)
})

test("after markDelivered with no new shareable entries returns empty history and retains cursor", () => {
  const sync = new ConversationHistorySync()
  const initialEntries = [
    makeEntry({ id: "entry-1", role: "user", content: "user 1" }),
    makeEntry({ id: "entry-2", role: "agent", agentId: "openclaw.gengar", content: "agent 2" })
  ]
  const initialResult = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries: initialEntries
  })

  sync.markDelivered({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    cursorEntryId: initialResult.cursorEntryId
  })

  const result = sync.getDelta({
    key: "conversation-a",
    sessionIdentity: "native-session-1",
    targetAgent: "openclaw.rowlet",
    entries: [
      ...initialEntries,
      makeEntry({ id: "entry-3", role: "system", content: "system 3" })
    ]
  })

  assert.deepEqual(result.history, [])
  assert.equal(result.cursorEntryId, "entry-2")
})
