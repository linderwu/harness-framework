import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  createConversationService,
  type ConversationBinding,
  unboundConversationId
} from "../lib/conversation"
import {
  getCodexConversationState,
  postCodexConversationMessage
} from "../lib/codex-conversation"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import type { ConversationEntry } from "../lib/hive-memory/types"
import type { WorkflowRun } from "../lib/types"
import { createWorkflowRun } from "../lib/workflow"

const openClawBridgeSource = readFileSync("scripts/openclaw-bridge.mjs", "utf8")

function createRun(projectType: WorkflowRun["projectType"] = "hive_mission") {
  return createWorkflowRun({
    projectId: "project-1",
    projectName: "Mission",
    projectType,
    repository: "owner/repo",
    requirement: "Verify conversation lifecycle",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
}

async function repositoryFixture(t: test.TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-conversation-lifecycle-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  return { repository }
}

async function conversationFixture(t: test.TestContext) {
  const { repository } = await repositoryFixture(t)
  const run = createRun()
  const service = createConversationService({
    repository,
    getRun: async (id) => (id === run.id ? run : undefined),
    buildContext: async () => undefined,
    invokeAgent: async () => ({ status: "completed", body: "Conversation reply" }),
    persistRawArtifact: async () => "artifact-1",
    enqueueManagerWake: async () => undefined,
    routeUnbound: async () =>
      ({
        status: "completed",
        body: "Still unbound"
      }) satisfies { status: "completed"; body: string; binding?: ConversationBinding }
  })
  return { repository, run, service }
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

async function ensureCompiledAlias() {
  const tmpRoot = join(process.cwd(), ".tmp-tests")
  const scopedRoot = join(tmpRoot, "node_modules", "@")
  const libLink = join(scopedRoot, "lib")

  await mkdir(scopedRoot, { recursive: true })
  await rm(libLink, { recursive: true, force: true }).catch(() => undefined)
  await symlink(join(tmpRoot, "lib"), libLink, "junction")
}

test("conversation GET returns a conversation id for durable client continuity", async () => {
  await ensureCompiledAlias()
  const { GET: getConversationRoute } = await import("../app/api/conversation/route")
  const response = await getConversationRoute()
  const body = await response.json() as { conversationId?: string }

  assert.equal(response.status, 200)
  assert.equal(body.conversationId, unboundConversationId)
})

test("conversation service exposes an explicit new-conversation command", async (t) => {
  const { service } = await conversationFixture(t)

  assert.equal(
    typeof (service as unknown as { startNewConversation?: unknown }).startNewConversation,
    "function"
  )
})

test("posting a Codex message stores entries under the requested conversation id", async (t) => {
  const { repository } = await repositoryFixture(t)
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    delete process.env.CODEX_BRIDGE_URL
    delete process.env.CODEX_BRIDGE_TOKEN
  })
  installFetchMock(t, async (input) => {
    const url = String(input)
    if (url === "http://codex.test/sessions") {
      return jsonResponse({
        id: "bridge-session-a",
        threadId: "thread-a",
        status: "idle",
        turnStatus: "completed",
        cursor: 0
      })
    }
    if (url === "http://codex.test/sessions/bridge-session-a/turns") {
      return jsonResponse({ ok: true })
    }
    if (url === "http://codex.test/sessions/bridge-session-a/events?after=0") {
      return jsonResponse({
        id: "bridge-session-a",
        threadId: "thread-a",
        status: "idle",
        turnStatus: "completed",
        cursor: 0,
        events: [],
        nextCursor: 0
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const result = await (
    postCodexConversationMessage as unknown as (input: {
      repository: unknown
      conversationId: string
      content: string
      idempotencyKey: string
    }) => Promise<{
      userEntry: ConversationEntry
      responseEntry?: ConversationEntry
    }>
  )({
    repository,
    conversationId: "conversation-a",
    content: "Inspect the harness",
    idempotencyKey: "codex-message-a"
  })

  assert.equal(result.userEntry.workflowRunId, "conversation-a")
  assert.equal(repository.listConversation("conversation-a").length, 2)
  assert.equal(
    repository.getCodexSession("conversation-a")?.bridgeSessionId,
    "bridge-session-a"
  )
})

test("reading Codex conversation state uses the requested conversation id session", async (t) => {
  const { repository } = await repositoryFixture(t)
  await repository.insertConversation({
    workflowRunId: "conversation-b",
    role: "user",
    agentId: "codex",
    content: "Continue this thread",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-b:user"
  })
  await repository.upsertCodexSession({
    conversationId: "conversation-b",
    bridgeSessionId: "bridge-session-b",
    codexThreadId: "thread-b",
    status: "idle",
    turnStatus: "completed",
    cursor: 7
  })

  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  t.after(() => {
    delete process.env.CODEX_BRIDGE_URL
    delete process.env.CODEX_BRIDGE_TOKEN
  })
  installFetchMock(t, async (input) => {
    const url = String(input)
    if (url === "http://codex.test/sessions/bridge-session-b/events?after=7") {
      return jsonResponse({
        id: "bridge-session-b",
        threadId: "thread-b",
        status: "idle",
        turnStatus: "completed",
        currentTurnId: "turn-b",
        cursor: 7,
        events: [],
        nextCursor: 7
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  })

  const state = await (
    getCodexConversationState as unknown as (
      repository: unknown,
      conversationId: string
    ) => Promise<{
      entries: ConversationEntry[]
      session?: { id: string }
    }>
  )(repository, "conversation-b")

  assert.equal(state.entries[0]?.workflowRunId, "conversation-b")
  assert.equal(state.session?.id, "bridge-session-b")
})

test("conversation control route requires a conversation id for Codex session controls", async () => {
  await ensureCompiledAlias()
  const { POST: postConversationControlRoute } = await import("../app/api/conversation/control/route")
  const response = await postConversationControlRoute(
    new Request("http://localhost/api/conversation/control", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "resume" })
    })
  )
  const body = await response.json() as { error?: string }

  assert.equal(response.status, 400)
  assert.match(body.error ?? "", /conversationId/i)
})

test("OpenClaw bridge session identity is derived from stable conversation input instead of only workflow ids", () => {
  assert.match(openClawBridgeSource, /sessionKey/)
  assert.match(openClawBridgeSource, /payload\.conversationId|payload\.sessionKey/)
})
