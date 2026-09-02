import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  buildSharedConversationHistory,
  formatSharedConversationPrompt
} from "../lib/conversation-history"
import { routeUnboundConversation } from "../lib/hive-services"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import type { ConversationEntry } from "../lib/hive-memory/types"

type SharedEntry = Pick<ConversationEntry, "id" | "role" | "agentId" | "content">

async function repositoryFixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-codex-shared-history-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return repository
}

test("unbound Codex dispatch supplies only the recent shared history to its adapter", async (t) => {
  const repository = await repositoryFixture(t)
  const conversationId = "conversation:codex-shared-history"
  const transcript: SharedEntry[] = Array.from({ length: 22 }, (_, index) => {
    const sequence = index + 1
    return {
      id: `entry-${sequence}`,
      role: sequence % 3 === 0 ? "manager" : sequence % 2 === 0 ? "agent" : "user",
      agentId: sequence % 3 === 0 ? "codex" : sequence % 2 === 0 ? "openclaw.rowlet" : "codex",
      content: `message ${sequence}`
    }
  })
  const histories: SharedEntry[][] = []

  const result = await routeUnboundConversation({
    repository,
    conversationId,
    targetAgent: "codex",
    content: "message 22",
    entries: transcript,
    invokeAgent: async (input) => {
      histories.push(input.conversationHistory as SharedEntry[])
      return { status: "completed", body: "adapter response", deliveryState: "confirmed" }
    }
  })

  assert.equal(result.status, "completed")
  assert.deepEqual(histories, [buildSharedConversationHistory(transcript.slice(-20))])
  assert.doesNotMatch(formatSharedConversationPrompt(histories[0]!), /message 1\b/)
})

test("unbound Codex dispatch preserves manager attribution in shared history", async (t) => {
  const repository = await repositoryFixture(t)
  const entries: SharedEntry[] = [
    { id: "user", role: "user", agentId: "codex", content: "operator request" },
    { id: "manager", role: "manager", agentId: "codex", content: "manager direction" }
  ]
  let history: SharedEntry[] | undefined

  await routeUnboundConversation({
    repository,
    conversationId: "conversation:codex-manager-history",
    targetAgent: "codex",
    content: "operator request",
    entries,
    invokeAgent: async (input) => {
      history = input.conversationHistory as SharedEntry[]
      return { status: "completed", body: "adapter response", deliveryState: "confirmed" }
    }
  })

  assert.deepEqual(history, buildSharedConversationHistory(entries))
  assert.match(formatSharedConversationPrompt(history!), /\[codex\] manager direction/)
})
