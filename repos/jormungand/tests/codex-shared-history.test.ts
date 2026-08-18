import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
  buildSharedConversationHistory,
  formatSharedConversationPrompt
} from "../lib/conversation-history"
import { postCodexConversationMessage } from "../lib/codex-conversation"
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
  return { repository }
}

function restoreEnv(t: test.TestContext, key: string) {
  const previousValue = process.env[key]
  t.after(() => {
    if (previousValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previousValue
    }
  })
}

function installFetchMock(
  t: test.TestContext,
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  t.after(() => {
    globalThis.fetch = originalFetch
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

function makeEntry(input: {
  id: string
  role: ConversationEntry["role"]
  content: string
  agentId?: ConversationEntry["agentId"]
}): SharedEntry {
  return input
}

async function insertConversationEntry(
  repository: ReturnType<typeof createHiveMemoryRepository>,
  conversationId: string,
  entry: SharedEntry
) {
  await repository.insertConversation({
    workflowRunId: conversationId,
    role: entry.role,
    agentId: entry.agentId,
    content: entry.content,
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: `${conversationId}:${entry.id}`
  })
  await new Promise((resolve) => setTimeout(resolve, 2))
}

function expectedPrompt(entries: SharedEntry[]) {
  return formatSharedConversationPrompt(buildSharedConversationHistory(entries))
}

test("Codex seeds the latest shared history for a new bridge session", async (t) => {
  const { repository } = await repositoryFixture(t)
  restoreEnv(t, "CODEX_BRIDGE_URL")
  process.env.CODEX_BRIDGE_URL = "http://codex.test"

  const conversationId = "conversation:codex-shared-seed"
  const seedEntries = Array.from({ length: 22 }, (_, index) => {
    const sequence = index + 1
    if (sequence % 3 === 1) {
      return makeEntry({
        id: `seed-${sequence}`,
        role: "user",
        content: `shared user ${sequence}`
      })
    }
    return makeEntry({
      id: `seed-${sequence}`,
      role: "agent",
      agentId: sequence % 3 === 2 ? "openclaw.rowlet" : "openclaw.gengar",
      content: `shared agent ${sequence}`
    })
  })
  for (const entry of seedEntries) {
    await insertConversationEntry(repository, conversationId, entry)
  }
  await insertConversationEntry(
    repository,
    "conversation:unrelated",
    makeEntry({
      id: "other-1",
      role: "agent",
      agentId: "openclaw.gengar",
      content: "other conversation should not leak"
    })
  )

  const turnBodies: string[] = []
  installFetchMock(t, async (input, init) => {
    const url = String(input)
    if (url === "http://codex.test/sessions") {
      return jsonResponse({
        id: "bridge-session-seed",
        threadId: "thread-seed",
        status: "idle",
        turnStatus: "completed",
        cursor: 0
      })
    }
    if (url === "http://codex.test/sessions/bridge-session-seed/turns") {
      turnBodies.push((JSON.parse(String(init?.body)) as { content: string }).content)
      return jsonResponse({ ok: true })
    }
    if (url === "http://codex.test/sessions/bridge-session-seed/events?after=0") {
      return jsonResponse({
        id: "bridge-session-seed",
        threadId: "thread-seed",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  await postCodexConversationMessage({
    repository,
    conversationId,
    content: "Need Codex summary",
    idempotencyKey: "codex-shared-seed"
  })

  assert.equal(turnBodies.length, 1)
  assert.equal(
    turnBodies[0],
    expectedPrompt([
      ...seedEntries,
      makeEntry({
        id: "current-user",
        role: "user",
        agentId: "codex",
        content: "Need Codex summary"
      })
    ])
  )
  assert.match(turnBodies[0], /BEGIN UNTRUSTED SHARED TRANSCRIPT/)
  assert.match(turnBodies[0], /\[openclaw\.rowlet\] shared agent 20/)
  assert.match(turnBodies[0], /\[openclaw\.gengar\] shared agent 21/)
  assert.doesNotMatch(turnBodies[0], /\bshared user 1\b/)
  assert.doesNotMatch(turnBodies[0], /\bshared agent 2\b/)
  assert.doesNotMatch(turnBodies[0], /\bshared agent 3\b/)
  assert.doesNotMatch(turnBodies[0], /other conversation should not leak/)
})

test("Codex only sends the post-cursor shared delta for the same session", async (t) => {
  const { repository } = await repositoryFixture(t)
  restoreEnv(t, "CODEX_BRIDGE_URL")
  process.env.CODEX_BRIDGE_URL = "http://codex.test"

  const conversationId = "conversation:codex-shared-delta"
  const turnBodies: string[] = []
  installFetchMock(t, async (input, init) => {
    const url = String(input)
    if (url === "http://codex.test/sessions") {
      return jsonResponse({
        id: "bridge-session-delta",
        threadId: "thread-delta",
        status: "idle",
        turnStatus: "completed",
        cursor: 0
      })
    }
    if (url === "http://codex.test/sessions/bridge-session-delta/turns") {
      turnBodies.push((JSON.parse(String(init?.body)) as { content: string }).content)
      return jsonResponse({ ok: true })
    }
    if (url === "http://codex.test/sessions/bridge-session-delta/events?after=0") {
      return jsonResponse({
        id: "bridge-session-delta",
        threadId: "thread-delta",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 1
      })
    }
    if (url === "http://codex.test/sessions/bridge-session-delta/events?after=1") {
      return jsonResponse({
        id: "bridge-session-delta",
        threadId: "thread-delta",
        status: "idle",
        turnStatus: "completed",
        cursor: 1,
        events: [],
        nextCursor: 1
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  await postCodexConversationMessage({
    repository,
    conversationId,
    content: "First Codex question",
    idempotencyKey: "codex-delta-1"
  })

  await insertConversationEntry(
    repository,
    conversationId,
    makeEntry({
      id: "codex-manager-1",
      role: "manager",
      agentId: "codex",
      content: "Codex manager note"
    })
  )
  await insertConversationEntry(
    repository,
    conversationId,
    makeEntry({
      id: "rowlet-1",
      role: "agent",
      agentId: "openclaw.rowlet",
      content: "Rowlet follow-up"
    })
  )

  await postCodexConversationMessage({
    repository,
    conversationId,
    content: "Second Codex question",
    idempotencyKey: "codex-delta-2"
  })

  assert.equal(turnBodies.length, 2)
  assert.equal(
    turnBodies[1],
    expectedPrompt([
      makeEntry({
        id: "rowlet-1",
        role: "agent",
        agentId: "openclaw.rowlet",
        content: "Rowlet follow-up"
      }),
      makeEntry({
        id: "current-user-2",
        role: "user",
        agentId: "codex",
        content: "Second Codex question"
      })
    ])
  )
  assert.doesNotMatch(turnBodies[1], /First Codex question/)
  assert.doesNotMatch(turnBodies[1], /Codex is working/)
  assert.doesNotMatch(turnBodies[1], /Codex manager note/)
})

test("Codex reseeds the latest shared history when either bridge session identity component changes", async (t) => {
  const { repository } = await repositoryFixture(t)
  restoreEnv(t, "CODEX_BRIDGE_URL")
  process.env.CODEX_BRIDGE_URL = "http://codex.test"

  const conversationId = "conversation:codex-shared-reseed"
  const seedEntries = [
    makeEntry({ id: "seed-1", role: "user", content: "shared user 1" }),
    makeEntry({
      id: "seed-2",
      role: "agent",
      agentId: "openclaw.rowlet",
      content: "shared rowlet 2"
    }),
    makeEntry({
      id: "seed-3",
      role: "agent",
      agentId: "openclaw.gengar",
      content: "shared gengar 3"
    })
  ]
  for (const entry of seedEntries) {
    await insertConversationEntry(repository, conversationId, entry)
  }

  const turnRequests: Array<{ bridgeSessionId: string; content: string }> = []
  const sessionCreations = [
    { id: "bridge-session-a", threadId: "thread-a" },
    { id: "bridge-session-b", threadId: "thread-a" },
    { id: "bridge-session-b", threadId: "thread-b" }
  ]
  let nextSessionCreationIndex = 0
  let bridgeSessionBEventsReads = 0
  installFetchMock(t, async (input, init) => {
    const url = String(input)
    if (url === "http://codex.test/sessions") {
      const nextIdentity =
        sessionCreations[nextSessionCreationIndex] ?? sessionCreations.at(-1)
      nextSessionCreationIndex += 1
      return jsonResponse({
        ...nextIdentity,
        status: "idle",
        turnStatus: "completed",
        cursor: 0
      })
    }
    if (url === "http://codex.test/sessions/bridge-session-a/turns") {
      turnRequests.push({
        bridgeSessionId: "bridge-session-a",
        content: (JSON.parse(String(init?.body)) as { content: string }).content
      })
      return jsonResponse({ ok: true })
    }
    if (url === "http://codex.test/sessions/bridge-session-a/events?after=0") {
      return jsonResponse({
        id: "bridge-session-a",
        threadId: "thread-a",
        status: turnRequests.length === 1 ? "idle" : "stopped",
        turnStatus: turnRequests.length === 1 ? "completed" : "failed",
        cursor: 0,
        events: [],
        nextCursor: 4
      })
    }
    if (url === "http://codex.test/sessions/bridge-session-a/events?after=4") {
      return jsonResponse({
        id: "bridge-session-a",
        threadId: "thread-a",
        status: "stopped",
        turnStatus: "failed",
        cursor: 4,
        events: [],
        nextCursor: 4
      })
    }
    if (url === "http://codex.test/sessions/bridge-session-b/turns") {
      turnRequests.push({
        bridgeSessionId: "bridge-session-b",
        content: (JSON.parse(String(init?.body)) as { content: string }).content
      })
      return jsonResponse({ ok: true })
    }
    if (url === "http://codex.test/sessions/bridge-session-b/events?after=0") {
      bridgeSessionBEventsReads += 1
      const eventState = bridgeSessionBEventsReads === 1
        ? {
            threadId: "thread-a",
            status: "idle",
            turnStatus: "completed"
          }
        : bridgeSessionBEventsReads === 2
          ? {
              threadId: "thread-a",
              status: "stopped",
              turnStatus: "failed"
            }
          : {
              threadId: "thread-b",
              status: "idle",
              turnStatus: "completed"
            }
      return jsonResponse({
        id: "bridge-session-b",
        ...eventState,
        cursor: 0,
        events: [],
        nextCursor: 0
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  await postCodexConversationMessage({
    repository,
    conversationId,
    content: "First Codex question",
    idempotencyKey: "codex-reseed-1"
  })

  const secondTurn = await postCodexConversationMessage({
    repository,
    conversationId,
    content: "Second Codex question after bridge restart",
    idempotencyKey: "codex-reseed-2"
  })

  const thirdTurn = await postCodexConversationMessage({
    repository,
    conversationId,
    content: "Third Codex question after thread restart",
    idempotencyKey: "codex-reseed-3"
  })

  assert.equal(turnRequests.length, 3)
  assert.equal(
    turnRequests[1]?.content,
    expectedPrompt(
      repository
        .listConversation(conversationId)
        .filter((entry) => entry.id !== secondTurn.responseEntry?.id)
    )
  )
  assert.equal(
    turnRequests[2]?.content,
    expectedPrompt(
      repository
        .listConversation(conversationId)
        .filter((entry) => entry.id !== thirdTurn.responseEntry?.id)
    )
  )
  assert.equal(repository.getCodexSession(conversationId)?.bridgeSessionId, "bridge-session-b")
  assert.equal(repository.getCodexSession(conversationId)?.codexThreadId, "thread-b")
  assert.equal(turnRequests[1]?.bridgeSessionId, "bridge-session-b")
  assert.equal(turnRequests[2]?.bridgeSessionId, "bridge-session-b")
  assert.match(turnRequests[1]?.content ?? "", /\[user\] shared user 1/)
  assert.match(turnRequests[1]?.content ?? "", /\[codex\] First Codex question/)
  assert.match(turnRequests[1]?.content ?? "", /\[codex\] Codex is working\.\.\./)
  assert.match(
    turnRequests[1]?.content ?? "",
    /\[codex\] Second Codex question after bridge restart/
  )
  assert.match(turnRequests[2]?.content ?? "", /\[user\] shared user 1/)
  assert.match(
    turnRequests[2]?.content ?? "",
    /\[codex\] Second Codex question after bridge restart/
  )
  assert.match(turnRequests[2]?.content ?? "", /\[codex\] Third Codex question after thread restart/)
})

test("Codex keeps the shared-history cursor unchanged when the first turn POST fails", async (t) => {
  const { repository } = await repositoryFixture(t)
  restoreEnv(t, "CODEX_BRIDGE_URL")
  process.env.CODEX_BRIDGE_URL = "http://codex.test"

  const conversationId = "conversation:codex-shared-turn-failure"
  const turnBodies: string[] = []
  let turnAttemptCount = 0
  installFetchMock(t, async (input, init) => {
    const url = String(input)
    if (url === "http://codex.test/sessions") {
      return jsonResponse({
        id: "bridge-session-failure",
        threadId: "thread-failure",
        status: "idle",
        turnStatus: "completed",
        cursor: 0
      })
    }
    if (url === "http://codex.test/sessions/bridge-session-failure/turns") {
      turnAttemptCount += 1
      turnBodies.push((JSON.parse(String(init?.body)) as { content: string }).content)
      if (turnAttemptCount === 1) {
        return jsonResponse({ error: "turn failed" }, 503)
      }
      return jsonResponse({ ok: true })
    }
    if (url === "http://codex.test/sessions/bridge-session-failure/events?after=0") {
      return jsonResponse({
        id: "bridge-session-failure",
        threadId: "thread-failure",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  await assert.rejects(
    postCodexConversationMessage({
      repository,
      conversationId,
      content: "First Codex question fails delivery",
      idempotencyKey: "codex-turn-failure-1"
    }),
    /turn failed/
  )

  const retryTurn = await postCodexConversationMessage({
    repository,
    conversationId,
    content: "Second Codex question retries delivery",
    idempotencyKey: "codex-turn-failure-2"
  })

  assert.equal(turnAttemptCount, 2)
  assert.equal(turnBodies.length, 2)
  assert.match(turnBodies[1] ?? "", /\[codex\] First Codex question fails delivery/)
  assert.match(turnBodies[1] ?? "", /\[codex\] Second Codex question retries delivery/)
  assert.doesNotMatch(turnBodies[1] ?? "", /BEGIN UNTRUSTED SHARED TRANSCRIPT\s*END UNTRUSTED SHARED TRANSCRIPT/)
  assert.equal(repository.getCodexSession(conversationId)?.bridgeSessionId, "bridge-session-failure")
  assert.equal(repository.getCodexSession(conversationId)?.codexThreadId, "thread-failure")
  assert.equal(retryTurn.userEntry.content, "Second Codex question retries delivery")
})
