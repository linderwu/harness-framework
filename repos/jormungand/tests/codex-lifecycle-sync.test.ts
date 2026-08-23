import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createConversationManagementService } from "../lib/conversation-management"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

test("conversation lifecycle mirrors rename, archive, and delete to native Codex", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-codex-lifecycle-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const conversationId = "conversation:lifecycle-sync"
  await repository.createConversation({ id: conversationId, title: "Initial" })
  await repository.upsertCodexSession({
    conversationId,
    bridgeSessionId: "bridge-lifecycle",
    codexThreadId: "thread-lifecycle",
    status: "idle",
    turnStatus: "completed"
  })
  const calls: string[] = []
  const service = createConversationManagementService({
    repository,
    stopSession: async () => { calls.push("stop") },
    renameNativeThread: async (id: string, title: string) => { calls.push(`rename:${id}:${title}`) },
    setNativeThreadState: async (id: string, state: "active" | "archived") => { calls.push(`state:${id}:${state}`) },
    deleteNativeThread: async (id: string) => { calls.push(`delete:${id}`) }
  })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  await service.updateConversation({ conversationId, title: "Renamed" })
  await service.updateConversation({ conversationId, state: "archived" })
  await service.updateConversation({ conversationId, state: "active" })
  await service.deleteConversation({ conversationId, confirm: true })

  assert.deepEqual(calls, [
    `rename:${conversationId}:Renamed`,
    `state:${conversationId}:archived`,
    `state:${conversationId}:active`,
    `delete:${conversationId}`,
    "stop"
  ])
})
