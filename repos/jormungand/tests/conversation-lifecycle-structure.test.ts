import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { pathToFileURL } from "node:url"
import test, { describe } from "node:test"
import type {} from "../app/api/conversations/route"
import type {} from "../app/api/conversations/[id]/route"
import type { AgentInvocationInput } from "../lib/agent-bridge"
import type { AgentKind, WorkflowEventSkill } from "../lib/types"
import {
  createConversationService,
  type ConversationBinding,
  unboundConversationId
} from "../lib/conversation"
import { ConversationHistorySync } from "../lib/conversation-history-sync"
import {
  buildSharedConversationHistory,
  sharedConversationHistoryLimit
} from "../lib/conversation-history"
import {
  getCodexConversationState,
  postCodexConversationMessage
} from "../lib/codex-conversation"
import {
  createHiveServices,
  routeOpenClawUnboundConversation,
  routeUnboundConversation
} from "../lib/hive-services"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"
import type { ConversationEntry } from "../lib/hive-memory/types"
import type { WorkflowRun } from "../lib/types"
import { createWorkflowRun } from "../lib/workflow"

const openClawBridgeSource = readFileSync("scripts/openclaw-bridge.mjs", "utf8")
const agentBridgeSource = readFileSync("lib/agent-bridge.ts", "utf8")

interface ConversationSummary {
  conversationId: string
  title: string
  state: "active" | "archived"
  messageCount: number
  latestMessage: string
  latestMessageAt: string
}

interface ConversationMetadata {
  conversationId: string
  title: string
  state: "active" | "archived"
}

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
  return { database, repository }
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

function assertDirectExecutionSkill(
  skill: Pick<WorkflowEventSkill, "id" | "purpose" | "constraints" | "gates">
) {
  assert.equal(skill.id, "conversation.direct_execution")
  assert.match(
    skill.purpose,
    /directly without requiring project or workflow binding/i
  )
  assert.match(
    skill.gates.join("\n"),
    /Server authentication and bridge authorization remain required/i
  )
  for (const clause of [skill.purpose, ...skill.constraints, ...skill.gates]) {
    assert.doesNotMatch(
      clause,
      /project-binding|manager-routing|external-action|irreversible-action|read-only/i
    )
  }
}

async function ensureCompiledAlias() {
  const tmpRoot = join(process.cwd(), ".tmp-tests")
  const scopedRoot = join(tmpRoot, "node_modules", "@")
  const libLink = join(scopedRoot, "lib")
  const expectedTarget = join(tmpRoot, "lib")

  await mkdir(scopedRoot, { recursive: true })
  const existingLink = await lstat(libLink).catch(() => undefined)
  const existingTarget = existingLink?.isSymbolicLink()
    ? await realpath(libLink).catch(() => undefined)
    : undefined
  const expectedRealTarget = await realpath(expectedTarget).catch(() => undefined)
  if (existingTarget && expectedRealTarget && existingTarget === expectedRealTarget) {
    return
  }
  if (existingLink) {
    await rm(libLink, { recursive: true, force: true })
  }
  await symlink(expectedTarget, libLink, "junction").catch(async (error) => {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
  })
}

function clearRouteModuleCache(routeModulePath: string) {
  delete require.cache[require.resolve(routeModulePath)]
  delete require.cache[require.resolve("../lib/hive-services")]
}

function closeRouteDatabase() {
  const servicesModule = require.cache[require.resolve("../lib/hive-services")]
  const getDefaultHiveServices = servicesModule?.exports?.getDefaultHiveServices as (() => {
    database: { close: () => void }
  }) | undefined
  getDefaultHiveServices?.().database.close()
}

async function importRouteWithIsolatedDataDir<T>(t: test.TestContext, routeModulePath: string) {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-route-env-"))
  const previousDataDir = process.env.JORMUNGAND_DATA_DIR
  process.env.JORMUNGAND_DATA_DIR = dataDir
  t.after(async () => {
    closeRouteDatabase()
    clearRouteModuleCache(routeModulePath)
    if (previousDataDir === undefined) {
      delete process.env.JORMUNGAND_DATA_DIR
    } else {
      process.env.JORMUNGAND_DATA_DIR = previousDataDir
    }
    await rm(dataDir, { recursive: true, force: true })
  })

  await ensureCompiledAlias()
  clearRouteModuleCache(routeModulePath)
  return await import(routeModulePath) as T
}

async function getRouteServices() {
  return await import("../lib/hive-services") as typeof import("../lib/hive-services")
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

async function loadOpenClawSessionHelper() {
  const loadModule = new Function(
    "modulePath",
    "return import(modulePath)"
  ) as (modulePath: string) => Promise<unknown>
  return await loadModule(pathToFileURL(resolve("scripts/openclaw-session.mjs")).href) as {
    deriveOpenClawSessionKey: (input: {
      mainAgent?: string
      conversationId?: unknown
    }) => string
  }
}

describe("conversation route contracts", { concurrency: false }, () => {
  test("conversation GET returns a conversation id for durable client continuity", async (t) => {
    const { GET: getConversationRoute } = await importRouteWithIsolatedDataDir<{
      GET: () => Promise<Response>
    }>(t, "../app/api/conversation/route")
    const response = await getConversationRoute()
    const body = await response.json() as { conversationId?: string }

    assert.equal(response.status, 200)
    assert.match(body.conversationId ?? "", /^conversation:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert.notEqual(body.conversationId, unboundConversationId)
  })

  test("conversation GET persists metadata when it creates a fresh unbound conversation", async (t) => {
    const { GET } = await importRouteWithIsolatedDataDir<{
      GET: (request: Request) => Promise<Response>
    }>(t, "../app/api/conversation/route")
    const { getDefaultHiveServices } = await getRouteServices()

    const response = await GET(new Request("http://localhost/api/conversation"))
    const body = await response.json() as {
      conversationId?: string
      metadata?: ConversationMetadata
    }
    const persistedMetadata = body.conversationId
      ? getDefaultHiveServices().repository.getConversationMetadata(body.conversationId)
      : undefined

    assert.equal(response.status, 200)
    assert.match(body.conversationId ?? "", /^conversation:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
    assert.equal(body.metadata?.conversationId, body.conversationId)
    assert.equal(body.metadata?.title, "New conversation")
    assert.equal(body.metadata?.state, "active")
    assert.equal(persistedMetadata?.conversationId, body.conversationId)
    assert.equal(persistedMetadata?.title, "New conversation")
    assert.equal(persistedMetadata?.state, "active")
  })

  test("conversation control route requires a conversation id for Codex session controls", async (t) => {
    const { POST: postConversationControlRoute } = await importRouteWithIsolatedDataDir<{
      POST: (request: Request) => Promise<Response>
    }>(t, "../app/api/conversation/control/route")
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

  test("conversation GET includes permission mode and current conversation metadata when available", async (t) => {
    restoreEnv(t, "JORMUNGAND_AGENT_PERMISSION_MODE")
    process.env.JORMUNGAND_AGENT_PERMISSION_MODE = "restricted"

    const { GET } = await importRouteWithIsolatedDataDir<{
      GET: (request: Request) => Promise<Response>
    }>(t, "../app/api/conversation/route")
    const { getDefaultHiveServices } = await getRouteServices()
    const services = getDefaultHiveServices()
    const conversationId = "conversation:99999999-9999-4999-8999-999999999999"

    await services.repository.createConversation({
      id: conversationId,
      title: "Existing managed conversation"
    })

    const response = await GET(
      new Request(`http://localhost/api/conversation?conversationId=${encodeURIComponent(conversationId)}`)
    )
    const body = await response.json() as {
      conversationId?: string
      permissionMode?: string
      metadata?: ConversationMetadata
    }

    assert.equal(response.status, 200)
    assert.equal(body.conversationId, conversationId)
    assert.equal(body.permissionMode, "restricted")
    assert.equal(body.metadata?.conversationId, conversationId)
    assert.equal(body.metadata?.title, "Existing managed conversation")
    assert.equal(body.metadata?.state, "active")
  })

  test("conversation new route persists active metadata as well as the cookie", async (t) => {
    const { POST } = await importRouteWithIsolatedDataDir<{
      POST: (request: Request) => Promise<Response>
    }>(t, "../app/api/conversation/new/route")
    const { getDefaultHiveServices } = await getRouteServices()

    const response = await POST(new Request("http://localhost/api/conversation/new", {
      method: "POST"
    }))
    const body = await response.json() as {
      conversationId?: string
      metadata?: ConversationMetadata
    }
    const metadata = body.conversationId
      ? getDefaultHiveServices().repository.getConversationMetadata(body.conversationId)
      : undefined

    assert.equal(response.status, 201)
    assert.match(body.conversationId ?? "", /^conversation:[0-9a-f-]{36}$/i)
    assert.equal(body.metadata?.conversationId, body.conversationId)
    assert.equal(body.metadata?.title, "New conversation")
    assert.equal(body.metadata?.state, "active")
    assert.ok(metadata)
    assert.equal(metadata?.state, "active")
    assert.equal(metadata?.title, "New conversation")
    assert.match(response.headers.get("set-cookie") ?? "", /jormungand-conversation-id=/i)
  })

  test("conversation new route returns the same 4xx JSON contract as the conversations create route", async (t) => {
    const { POST: postConversationNew } = await importRouteWithIsolatedDataDir<{
      POST: (request: Request) => Promise<Response>
    }>(t, "../app/api/conversation/new/route")
    const { POST: postConversations } = await importRouteWithIsolatedDataDir<{
      POST: (request: Request) => Promise<Response>
    }>(t, "../app/api/conversations/route")

    const requestBody = JSON.stringify({ title: 123 })
    const [newResponse, collectionResponse] = await Promise.all([
      postConversationNew(new Request("http://localhost/api/conversation/new", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody
      })),
      postConversations(new Request("http://localhost/api/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: requestBody
      }))
    ])

    const newBody = await newResponse.json() as { error?: string }
    const collectionBody = await collectionResponse.json() as { error?: string }

    assert.equal(newResponse.status, 400)
    assert.equal(collectionResponse.status, 400)
    assert.deepEqual(newBody, collectionBody)
  })

  test("conversations collection route creates managed conversations and filters archived items by default", async (t) => {
    const { GET, POST } = await importRouteWithIsolatedDataDir<{
      GET: (request: Request) => Promise<Response>
      POST: (request: Request) => Promise<Response>
    }>(t, "../app/api/conversations/route")
    const { getDefaultHiveServices } = await getRouteServices()
    const services = getDefaultHiveServices()

    const createResponse = await POST(new Request("http://localhost/api/conversations", {
      method: "POST"
    }))
    const created = await createResponse.json() as { conversationId?: string }
    assert.equal(createResponse.status, 201)
    assert.ok(created.conversationId)

    await services.repository.createConversation({
      id: "conversation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      title: "Archive me"
    })
    await services.repository.setConversationState(
      "conversation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "archived"
    )

    const activeOnlyResponse = await GET(new Request("http://localhost/api/conversations"))
    const activeOnlyBody = await activeOnlyResponse.json() as {
      conversations?: ConversationSummary[]
    }
    assert.equal(activeOnlyResponse.status, 200)
    assert.equal(
      activeOnlyBody.conversations?.some(
        (conversation) =>
          conversation.conversationId === "conversation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      ),
      false
    )
    assert.equal(
      activeOnlyBody.conversations?.some(
        (conversation) => conversation.conversationId === created.conversationId
      ),
      true
    )

    const includeArchivedResponse = await GET(
      new Request("http://localhost/api/conversations?includeArchived=true")
    )
    const includeArchivedBody = await includeArchivedResponse.json() as {
      conversations?: ConversationSummary[]
    }
    assert.equal(includeArchivedResponse.status, 200)
    assert.equal(
      includeArchivedBody.conversations?.some(
        (conversation) =>
          conversation.conversationId === "conversation:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" &&
          conversation.state === "archived"
      ),
      true
    )
  })

  test("conversation detail route renames, archives, and requires delete confirmation", async (t) => {
    const { PATCH, DELETE } = await importRouteWithIsolatedDataDir<{
      PATCH: (
        request: Request,
        context: { params: Promise<{ id: string }> }
      ) => Promise<Response>
      DELETE: (
        request: Request,
        context: { params: Promise<{ id: string }> }
      ) => Promise<Response>
    }>(t, "../app/api/conversations/[id]/route")
    const { getDefaultHiveServices } = await getRouteServices()
    const services = getDefaultHiveServices()
    const conversationId = "conversation:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"

    await services.repository.createConversation({
      id: conversationId,
      title: "Rename me"
    })

    const renameResponse = await PATCH(
      new Request(`http://localhost/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: "  Renamed from route  " })
      }),
      { params: Promise.resolve({ id: conversationId }) }
    )
    const renamed = await renameResponse.json() as ConversationSummary
    assert.equal(renameResponse.status, 200)
    assert.equal(renamed.title, "Renamed from route")

    const archiveResponse = await PATCH(
      new Request(`http://localhost/api/conversations/${conversationId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state: "archived" })
      }),
      { params: Promise.resolve({ id: conversationId }) }
    )
    const archived = await archiveResponse.json() as ConversationSummary
    assert.equal(archiveResponse.status, 200)
    assert.equal(archived.state, "archived")

    const deleteWithoutConfirm = await DELETE(
      new Request(`http://localhost/api/conversations/${conversationId}`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({})
      }),
      { params: Promise.resolve({ id: conversationId }) }
    )
    assert.equal(deleteWithoutConfirm.status, 400)
  })
})

test("conversation service exposes an explicit new-conversation command", async (t) => {
  const { repository, service } = await conversationFixture(t)
  await repository.insertConversation({
    workflowRunId: unboundConversationId,
    role: "user",
    agentId: "codex",
    content: "Keep this transcript",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "existing-transcript"
  })
  const existingEntries = repository.listConversation(unboundConversationId)
  const startNewConversation = (service as unknown as {
    startNewConversation?: () => unknown
  }).startNewConversation

  if (typeof startNewConversation !== "function") {
    assert.fail("ConversationService must expose startNewConversation() for the new conversation flow.")
  }

  const result = startNewConversation()
  const newConversationId = typeof result === "string"
    ? result
    : (result as { conversationId?: string } | undefined)?.conversationId

  assert.equal(typeof newConversationId, "string")
  assert.notEqual(newConversationId, unboundConversationId)
  assert.deepEqual(repository.listConversation(unboundConversationId), existingEntries)
  assert.deepEqual(repository.listConversation(String(newConversationId)), [])
})

test("posting a Codex message stores entries under the requested conversation id", async (t) => {
  const { repository } = await repositoryFixture(t)
  restoreEnv(t, "CODEX_BRIDGE_URL")
  restoreEnv(t, "CODEX_BRIDGE_TOKEN")
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
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

  restoreEnv(t, "CODEX_BRIDGE_URL")
  restoreEnv(t, "CODEX_BRIDGE_TOKEN")
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
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

test("Codex cursor updates stay monotonic and state exposes the persisted effective cursor", async (t) => {
  const { repository } = await repositoryFixture(t)
  await repository.upsertCodexSession({
    conversationId: "conversation-cursor",
    bridgeSessionId: "bridge-session-cursor",
    codexThreadId: "thread-cursor",
    status: "idle",
    turnStatus: "completed",
    cursor: 7
  })

  const regressed = await repository.updateCodexSession({
    conversationId: "conversation-cursor",
    cursor: 3
  })
  assert.equal(regressed?.cursor, 7)

  restoreEnv(t, "CODEX_BRIDGE_URL")
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  installFetchMock(t, async (input) => {
    assert.equal(String(input), "http://codex.test/sessions/bridge-session-cursor/events?after=7")
    return jsonResponse({
      id: "bridge-session-cursor",
      threadId: "thread-cursor",
      status: "idle",
      turnStatus: "completed",
      cursor: 3,
      events: [],
      nextCursor: 3
    })
  })

  const state = await getCodexConversationState(repository, "conversation-cursor")
  assert.equal(state.session?.cursor, 7)
  assert.equal(state.nextCursor, 7)
})

test("unbound Codex routing dispatches directly to Codex with direct execution skill context", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  const capturedInputs: AgentInvocationInput[] = []
  const services = createHiveServices({
    database,
    repository,
    listProjects: async () => {
      throw new Error("listProjects should not be called for unbound Codex conversations")
    },
    listWorkflowRuns: async () => {
      throw new Error("listWorkflowRuns should not be called for unbound Codex conversations")
    },
    invokeAgent: async (input) => {
      capturedInputs.push(input)
      return {
        status: "completed",
        source: "simulated",
        body: "Direct Codex reply"
      }
    }
  })

  const conversationId = "conversation:direct-codex"
  const content = "Please answer directly from the unbound conversation."

  await services.conversation.postUnboundMessage({
    conversationId,
    targetAgent: "codex",
    content,
    idempotencyKey: "codex-unbound-direct"
  })

  assert.equal(capturedInputs.length, 1)
  const invocation = capturedInputs[0]
  assert.equal(invocation?.executor, "codex")
  assert.equal(invocation?.conversationId, conversationId)
  assert.equal(invocation?.idempotencyKey, "conversation:direct-codex:codex-unbound-direct")
  assert.equal(invocation?.skill.id, "conversation.direct_execution")
  assert.equal(
    invocation?.conversationHistory?.some(
      (entry) => entry.role === "user"
        && entry.content.endsWith(content)
        && entry.content.includes(content)
    ),
    true
  )
  assertDirectExecutionSkill(invocation.skill)
})

test("queued unbound Codex routing drains through direct execution instead of Codex session dispatch", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  const capturedInputs: AgentInvocationInput[] = []
  const services = createHiveServices({
    database,
    repository,
    startCodexSyncWorker: false,
    listProjects: async () => {
      throw new Error("listProjects should not be called for queued unbound Codex conversations")
    },
    listWorkflowRuns: async () => {
      throw new Error("listWorkflowRuns should not be called for queued unbound Codex conversations")
    },
    invokeAgent: async (input) => {
      capturedInputs.push(input)
      return {
        status: "completed",
        source: "simulated",
        body: "Queued direct Codex reply"
      }
    }
  })

  const queued = await services.conversation.enqueueUnboundMessage({
    conversationId: "conversation:queued-codex",
    targetAgent: "codex",
    content: "Drain this queued unbound Codex message directly.",
    idempotencyKey: "queued-unbound-codex"
  })
  await services.conversationDispatcher.drain("conversation:queued-codex")

  if (!("status" in queued)) {
    assert.fail("Queued unbound conversation should return a queue status.")
  }
  assert.equal(queued.status, "queued")
  assert.equal(capturedInputs.length, 1)
  assert.equal(capturedInputs[0]?.executor, "codex")
  assert.equal(capturedInputs[0]?.conversationId, "conversation:queued-codex")
  assert.equal(
    capturedInputs[0]?.idempotencyKey,
    "conversation:queued-codex:queued-unbound-codex"
  )
  assertDirectExecutionSkill(capturedInputs[0]!.skill)

  const storedUser = repository.getConversationByIdempotencyKey(
    "conversation:queued-codex:queued-unbound-codex"
  )
  const storedResponse = repository.getConversationByIdempotencyKey(
    "conversation:queued-codex:queued-unbound-codex:response"
  )
  assert.equal(storedUser?.status, "completed")
  assert.equal(storedResponse?.content, "Queued direct Codex reply")
  assert.equal(storedResponse?.status, "completed")
})

test("queued bound Codex routing still uses the workflow manager conversation skill", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  let persistedRun = createRun()
  const capturedInputs: AgentInvocationInput[] = []
  const services = createHiveServices({
    database,
    repository,
    startCodexSyncWorker: false,
    getRun: async (id) => (id === persistedRun.id ? persistedRun : undefined),
    saveRun: async (run) => {
      persistedRun = run
      return run
    },
    invokeAgent: async (input) => {
      capturedInputs.push(input)
      return {
        status: "completed",
        source: "simulated",
        body: "Bound Codex manager reply"
      }
    }
  })

  const queued = await services.conversation.enqueueMessage({
    workflowRunId: persistedRun.id,
    targetAgent: "codex",
    content: "Handle this inside the active workflow.",
    idempotencyKey: "queued-bound-codex"
  })
  await services.conversationDispatcher.drain(persistedRun.id)

  if (!("status" in queued)) {
    assert.fail("Queued workflow conversation should return a queue status.")
  }
  assert.equal(queued.status, "queued")
  assert.equal(capturedInputs.length, 1)
  assert.equal(capturedInputs[0]?.executor, "codex")
  assert.equal(capturedInputs[0]?.skill.id, "hive_manager.operator_message")
  assert.equal(capturedInputs[0]?.conversationId, undefined)
})

test("unbound direct redispatch preserves the persisted entry idempotency key", async (t) => {
  const { repository } = await repositoryFixture(t)
  const capturedInputs: AgentInvocationInput[] = []
  const entry = {
    id: "entry-redispatch",
    role: "user" as const,
    agentId: "codex" as const,
    content: "Redispatch this persisted entry."
  }
  const routeInput = {
    repository,
    conversationId: "conversation:redispatch",
    targetAgent: "codex" as const,
    content: entry.content,
    entries: [entry],
    idempotencyKey: "conversation:redispatch:entry-redispatch",
    invokeAgent: async (input: AgentInvocationInput) => {
      capturedInputs.push(input)
      return {
        status: "completed" as const,
        source: "simulated" as const,
        body: "Direct response"
      }
    }
  }

  await routeUnboundConversation(routeInput)
  await routeUnboundConversation(routeInput)

  assert.deepEqual(
    capturedInputs.map((input) => input.idempotencyKey),
    ["conversation:redispatch:entry-redispatch", "conversation:redispatch:entry-redispatch"]
  )
})

test("unbound OpenClaw direct routing bounds first bootstrap history to the newest 20 shareable entries", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  const capturedInputs: AgentInvocationInput[] = []
  const services = createHiveServices({
    database,
    repository,
    startCodexSyncWorker: false,
    listProjects: async () => {
      throw new Error("listProjects should not be called for unbound OpenClaw conversations")
    },
    listWorkflowRuns: async () => {
      throw new Error("listWorkflowRuns should not be called for unbound OpenClaw conversations")
    },
    invokeAgent: async (input) => {
      capturedInputs.push(input)
      return {
        status: "completed",
        source: "simulated",
        body: "Bounded OpenClaw bootstrap reply"
      }
    }
  })
  const waitForConversationOrder = () => new Promise<void>((resolve) => setTimeout(resolve, 2))

  for (let index = 1; index <= 24; index += 1) {
    await repository.insertConversation({
      workflowRunId: "conversation:bootstrap-bounded",
      role: index % 2 === 0 ? "manager" : "user",
      agentId: index % 2 === 0 ? "codex" : "openclaw.gengar",
      content: `shareable-${index}`,
      importance: "important",
      status: "completed",
      artifactIds: [],
      memoryIds: [],
      idempotencyKey: `conversation:bootstrap-bounded:shareable-${index}`
    })
    await waitForConversationOrder()
    if (index % 4 === 0) {
      await repository.insertConversation({
        workflowRunId: "conversation:bootstrap-bounded",
        role: "system",
        agentId: "codex",
        content: `system-${index} is not shareable`,
        importance: "normal",
        status: "completed",
        artifactIds: [],
        memoryIds: [],
        idempotencyKey: `conversation:bootstrap-bounded:system-${index}`
      })
      await waitForConversationOrder()
    }
  }

  const existingEntries = repository.listConversation("conversation:bootstrap-bounded")
  const result = await services.conversation.postUnboundMessage({
    conversationId: "conversation:bootstrap-bounded",
    targetAgent: "openclaw.gengar",
    content: "Use only the bounded newest bootstrap history.",
    idempotencyKey: "conversation:bootstrap-bounded:first"
  })
  const bootstrapHistory = capturedInputs[0]?.conversationHistory
  const expectedBootstrap = buildSharedConversationHistory(
    [...existingEntries, result.userEntry]
      .filter((entry) => entry.role === "user" || entry.role === "agent" || entry.role === "manager")
      .slice(-sharedConversationHistoryLimit)
  )

  assert.equal(capturedInputs.length, 1)
  assert.equal(bootstrapHistory?.length, sharedConversationHistoryLimit)
  assert.deepEqual(bootstrapHistory, expectedBootstrap)
  assert.equal(
    bootstrapHistory?.some((entry) => entry.content.endsWith("shareable-1")),
    false
  )
  assert.equal(
    bootstrapHistory?.some((entry) => entry.content.endsWith("shareable-6")),
    true
  )
  assert.equal(
    bootstrapHistory?.some((entry) => entry.content.endsWith("shareable-24")),
    true
  )
  assert.equal(
    bootstrapHistory?.at(-1)?.content,
    "[openclaw.gengar] Use only the bounded newest bootstrap history."
  )
})

test("unbound OpenClaw direct routing persists per-agent runtime state and skips bootstrap after first success", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  const capturedInputs: AgentInvocationInput[] = []
  const services = createHiveServices({
    database,
    repository,
    listProjects: async () => {
      throw new Error("listProjects should not be called for unbound OpenClaw conversations")
    },
    listWorkflowRuns: async () => {
      throw new Error("listWorkflowRuns should not be called for unbound OpenClaw conversations")
    },
    invokeAgent: async (input) => {
      capturedInputs.push(input)
      return {
        status: "completed",
        source: "simulated",
        body: `Direct reply ${capturedInputs.length}`
      }
    }
  })

  await repository.insertConversation({
    workflowRunId: "conversation-runtime",
    role: "manager",
    agentId: "codex",
    content: "Earlier manager note",
    importance: "important",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-runtime:seed-manager"
  })
  await repository.insertConversation({
    workflowRunId: "conversation-runtime",
    role: "system",
    agentId: "codex",
    content: "System messages must not be shared as bootstrap history",
    importance: "normal",
    status: "completed",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: "conversation-runtime:seed-system"
  })

  const first = await services.conversation.postUnboundMessage({
    conversationId: "conversation-runtime",
    targetAgent: "openclaw.gengar",
    content: "First persistent turn",
    idempotencyKey: "conversation-runtime:first"
  })
  const firstRuntime = repository.getOpenClawRuntimeSession(
    "conversation-runtime",
    "openclaw.gengar"
  )

  assert.equal(capturedInputs[0]?.conversationHistory?.length, 2)
  assert.equal(
    capturedInputs[0]?.conversationHistory?.some(
      (entry) => entry.content === "[codex] Earlier manager note"
    ),
    true
  )
  assert.equal(
    capturedInputs[0]?.conversationHistory?.some(
      (entry) => entry.content === "[openclaw.gengar] First persistent turn"
    ),
    true
  )
  assert.equal(
    capturedInputs[0]?.conversationHistory?.some(
      (entry) => entry.content.includes("System messages must not be shared")
    ),
    false
  )
  assertDirectExecutionSkill(capturedInputs[0]!.skill)
  assert.equal(firstRuntime?.state, "active")
  assert.equal(firstRuntime?.sessionNamespace, "harness-direct-v1")
  assert.equal(firstRuntime?.bootstrapDelivered, true)
  assert.equal(firstRuntime?.lastDeliveredEntryId, first.userEntry.id)
  assert.match(firstRuntime?.sessionKeyFingerprint ?? "", /^sha256:[0-9a-f]{64}$/)

  const firstFingerprint = firstRuntime?.sessionKeyFingerprint
  const second = await services.conversation.postUnboundMessage({
    conversationId: "conversation-runtime",
    targetAgent: "openclaw.gengar",
    content: "Second turn should reuse the persistent transcript",
    idempotencyKey: "conversation-runtime:second"
  })
  const secondRuntime = repository.getOpenClawRuntimeSession(
    "conversation-runtime",
    "openclaw.gengar"
  )

  assert.equal(capturedInputs[1]?.conversationHistory, undefined)
  assert.equal(secondRuntime?.state, "active")
  assert.equal(secondRuntime?.bootstrapDelivered, true)
  assert.equal(secondRuntime?.lastDeliveredEntryId, second.userEntry.id)
  assert.equal(secondRuntime?.sessionKeyFingerprint, firstFingerprint)

  const rowlet = await services.conversation.postUnboundMessage({
    conversationId: "conversation-runtime",
    targetAgent: "openclaw.rowlet",
    content: "Different agent gets its own bootstrap",
    idempotencyKey: "conversation-runtime:rowlet"
  })
  const rowletRuntime = repository.getOpenClawRuntimeSession(
    "conversation-runtime",
    "openclaw.rowlet"
  )

  assert.equal(
    capturedInputs[2]?.conversationHistory?.some(
      (entry) => entry.content === "[openclaw.rowlet] Different agent gets its own bootstrap"
    ),
    true
  )
  assert.equal(
    capturedInputs[2]?.conversationHistory?.some(
      (entry) => entry.content.includes("System messages must not be shared")
    ),
    false
  )
  assert.equal(rowletRuntime?.bootstrapDelivered, true)
  assert.equal(rowletRuntime?.lastDeliveredEntryId, rowlet.userEntry.id)
  assert.notEqual(rowletRuntime?.sessionKeyFingerprint, firstFingerprint)

  const otherConversation = await services.conversation.postUnboundMessage({
    conversationId: "conversation-other",
    targetAgent: "openclaw.gengar",
    content: "Different conversation gets an isolated runtime row",
    idempotencyKey: "conversation-other:first"
  })
  const otherRuntime = repository.getOpenClawRuntimeSession(
    "conversation-other",
    "openclaw.gengar"
  )

  assert.deepEqual(
    capturedInputs[3]?.conversationHistory,
    buildSharedConversationHistory([otherConversation.userEntry])
  )
  assert.equal(otherRuntime?.bootstrapDelivered, true)
  assert.equal(otherRuntime?.lastDeliveredEntryId, otherConversation.userEntry.id)
  assert.notEqual(otherRuntime?.sessionKeyFingerprint, firstFingerprint)
})

test("unbound OpenClaw direct routing keeps bootstrap pending after failed first delivery", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  const capturedInputs: AgentInvocationInput[] = []
  const services = createHiveServices({
    database,
    repository,
    listProjects: async () => {
      throw new Error("listProjects should not be called for unbound OpenClaw conversations")
    },
    listWorkflowRuns: async () => {
      throw new Error("listWorkflowRuns should not be called for unbound OpenClaw conversations")
    },
    invokeAgent: async (input) => {
      capturedInputs.push(input)
      return {
        status: capturedInputs.length === 1 ? "failed" : "completed",
        source: "simulated",
        body: `Direct reply ${capturedInputs.length}`
      }
    }
  })

  const failedFirstTurn = await services.conversation.postUnboundMessage({
    conversationId: "conversation-failure",
    targetAgent: "openclaw.gengar",
    content: "The first direct delivery should fail",
    idempotencyKey: "conversation-failure:first"
  })
  const afterFailure = repository.getOpenClawRuntimeSession(
    "conversation-failure",
    "openclaw.gengar"
  )

  assert.deepEqual(
    capturedInputs[0]?.conversationHistory,
    buildSharedConversationHistory([failedFirstTurn.userEntry])
  )
  assert.equal(afterFailure?.state, "pending")
  assert.equal(afterFailure?.bootstrapDelivered, false)
  assert.equal(afterFailure?.lastDeliveredEntryId, undefined)

  const retryExistingEntries = repository.listConversation("conversation-failure")
  const retriedTurn = await services.conversation.postUnboundMessage({
    conversationId: "conversation-failure",
    targetAgent: "openclaw.gengar",
    content: "The retry should bootstrap again and activate the session",
    idempotencyKey: "conversation-failure:retry"
  })
  const afterRetry = repository.getOpenClawRuntimeSession(
    "conversation-failure",
    "openclaw.gengar"
  )

  assert.deepEqual(
    capturedInputs[1]?.conversationHistory,
    buildSharedConversationHistory([
      ...retryExistingEntries,
      retriedTurn.userEntry
    ])
  )
  assert.equal(afterRetry?.state, "active")
  assert.equal(afterRetry?.bootstrapDelivered, true)
  assert.equal(afterRetry?.lastDeliveredEntryId, retriedTurn.userEntry.id)
})

test("unbound OpenClaw direct routing records ambiguous first delivery without retrying it", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  const capturedInputs: AgentInvocationInput[] = []
  const services = createHiveServices({
    database,
    repository,
    startCodexSyncWorker: false,
    invokeAgent: async (input) => {
      capturedInputs.push(input)
      return {
        status: "failed",
        source: "simulated",
        body: "Delivery outcome is ambiguous.",
        deliveryState: "unknown"
      }
    }
  })

  const first = await services.conversation.postUnboundMessage({
    conversationId: "conversation:ambiguous-first",
    targetAgent: "openclaw.gengar",
    content: "The first request may have been accepted.",
    idempotencyKey: "conversation:ambiguous-first:request"
  })
  const duplicate = await services.conversation.postUnboundMessage({
    conversationId: "conversation:ambiguous-first",
    targetAgent: "openclaw.gengar",
    content: "The first request may have been accepted.",
    idempotencyKey: "conversation:ambiguous-first:request"
  })
  const runtime = repository.getOpenClawRuntimeSession(
    "conversation:ambiguous-first",
    "openclaw.gengar"
  )

  assert.equal(first.userEntry.status, "failed")
  assert.equal(duplicate.userEntry.id, first.userEntry.id)
  assert.equal(capturedInputs.length, 1)
  assert.equal(runtime?.state, "delivery_unknown")
  assert.equal(runtime?.bootstrapDelivered, false)
  assert.equal(runtime?.lastDeliveredEntryId, undefined)
})

test("unbound OpenClaw direct routing preserves the cursor after ambiguous later delivery", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  const capturedInputs: AgentInvocationInput[] = []
  let attempt = 0
  const services = createHiveServices({
    database,
    repository,
    startCodexSyncWorker: false,
    invokeAgent: async (input) => {
      capturedInputs.push(input)
      attempt += 1
      return attempt === 1
        ? {
            status: "completed" as const,
            source: "simulated" as const,
            body: "First turn confirmed."
          }
        : {
            status: "failed" as const,
            source: "simulated" as const,
            body: "Later turn outcome is ambiguous.",
            deliveryState: "unknown" as const
          }
    }
  })

  const first = await services.conversation.postUnboundMessage({
    conversationId: "conversation:ambiguous-later",
    targetAgent: "openclaw.gengar",
    content: "Confirmed first turn.",
    idempotencyKey: "conversation:ambiguous-later:first"
  })
  const second = await services.conversation.postUnboundMessage({
    conversationId: "conversation:ambiguous-later",
    targetAgent: "openclaw.gengar",
    content: "The later request may have been accepted.",
    idempotencyKey: "conversation:ambiguous-later:second"
  })
  const runtime = repository.getOpenClawRuntimeSession(
    "conversation:ambiguous-later",
    "openclaw.gengar"
  )

  assert.equal(first.userEntry.status, "completed")
  assert.equal(second.userEntry.status, "failed")
  assert.equal(capturedInputs.length, 2)
  assert.equal(capturedInputs[1]?.conversationHistory, undefined)
  assert.equal(runtime?.state, "delivery_unknown")
  assert.equal(runtime?.bootstrapDelivered, true)
  assert.equal(runtime?.lastDeliveredEntryId, first.userEntry.id)
})

test("a new OpenClaw entry after ambiguous delivery uses the persistent session without old bootstrap", async (t) => {
  const { database, repository } = await repositoryFixture(t)
  const capturedInputs: AgentInvocationInput[] = []
  let attempt = 0
  const services = createHiveServices({
    database,
    repository,
    startCodexSyncWorker: false,
    invokeAgent: async (input) => {
      capturedInputs.push(input)
      attempt += 1
      return attempt === 1
        ? {
            status: "failed" as const,
            source: "simulated" as const,
            body: "First turn outcome is ambiguous.",
            deliveryState: "unknown" as const
          }
        : {
            status: "completed" as const,
            source: "simulated" as const,
            body: "Fresh turn confirmed."
          }
    }
  })

  const first = await services.conversation.postUnboundMessage({
    conversationId: "conversation:ambiguous-recovery",
    targetAgent: "openclaw.gengar",
    content: "The first request may have been accepted.",
    idempotencyKey: "conversation:ambiguous-recovery:first"
  })
  const afterAmbiguous = repository.getOpenClawRuntimeSession(
    "conversation:ambiguous-recovery",
    "openclaw.gengar"
  )
  assert.equal(capturedInputs.length, 1)

  const second = await services.conversation.postUnboundMessage({
    conversationId: "conversation:ambiguous-recovery",
    targetAgent: "openclaw.gengar",
    content: "This is a new operator turn.",
    idempotencyKey: "conversation:ambiguous-recovery:second"
  })
  const afterConfirmed = repository.getOpenClawRuntimeSession(
    "conversation:ambiguous-recovery",
    "openclaw.gengar"
  )

  assert.equal(first.userEntry.status, "failed")
  assert.equal(afterAmbiguous?.state, "delivery_unknown")
  assert.equal(afterAmbiguous?.lastDeliveredEntryId, undefined)
  assert.equal(second.userEntry.status, "completed")
  assert.equal(capturedInputs.length, 2)
  assert.equal(capturedInputs[1]?.conversationHistory, undefined)
  assert.equal(afterConfirmed?.state, "active")
  assert.equal(afterConfirmed?.bootstrapDelivered, true)
  assert.equal(afterConfirmed?.lastDeliveredEntryId, second.userEntry.id)
})

test("OpenClaw bridge session identity is derived from stable conversation input instead of only workflow ids", () => {
  assert.match(openClawBridgeSource, /sessionKey/)
  assert.match(openClawBridgeSource, /payload\.conversationId|payload\.sessionKey/)
})

test("OpenClaw agent bridge uses the shared typed session adapter", () => {
  assert.match(agentBridgeSource, /from "\.\/openclaw-session"/)
  assert.doesNotMatch(agentBridgeSource, /new Function\(\s*"modulePath"/)
  assert.doesNotMatch(agentBridgeSource, /scripts\/openclaw-session\.mjs/)
})

test("unbound OpenClaw routing preserves conversation and agent identity at the bridge boundary", { concurrency: false }, async (t) => {
  await ensureCompiledAlias()
  const { database, repository } = await repositoryFixture(t)
  for (const key of [
    "OPENCLAW_BRIDGE_URL",
    "OPENCLAW_BRIDGE_TOKEN",
    "OPENCLAW_GATEWAY_TOKEN",
    "OPENCLAW_A2A_COMMAND"
  ]) {
    restoreEnv(t, key)
  }
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"
  delete process.env.OPENCLAW_A2A_COMMAND

  const bridgePayloads: Array<{
    conversationId?: string
    executor?: AgentKind
    mainAgent?: string
    idempotencyKey?: string
    skill?: Pick<WorkflowEventSkill, "id" | "purpose" | "constraints" | "gates">
  }> = []
  installFetchMock(t, async (input, init) => {
    assert.equal(String(input), "http://openclaw.test/agent-runs")
    assert.equal(init?.method, "POST")
    const payload = JSON.parse(String(init?.body)) as typeof bridgePayloads[number]
    bridgePayloads.push(payload)
    return jsonResponse({
      id: `bridge-run-${bridgePayloads.length}`,
      status: "completed",
      output: `OpenClaw reply ${bridgePayloads.length}`,
      idempotencyKey: payload.idempotencyKey
    })
  })

  const services = createHiveServices({
    database,
    repository,
    listProjects: async () => {
      throw new Error("listProjects should not be called for unbound OpenClaw conversations")
    },
    listWorkflowRuns: async () => {
      throw new Error("listWorkflowRuns should not be called for unbound OpenClaw conversations")
    }
  })

  const post = (conversationId: string, targetAgent: AgentKind, sequence: number) =>
    services.conversation.postUnboundMessage({
      conversationId,
      targetAgent,
      content: `Message ${sequence}`,
      idempotencyKey: `openclaw-boundary-${sequence}`
    })
  await post("conversation-a", "openclaw.gengar", 1)
  await post("conversation-a", "openclaw.gengar", 2)
  await post("conversation-a", "openclaw.rowlet", 3)
  await post("conversation-b", "openclaw.gengar", 4)

  assert.equal(bridgePayloads.length, 4)
  for (const payload of bridgePayloads) {
    assert.ok(payload.skill)
    assertDirectExecutionSkill(payload.skill)
  }

  assert.deepEqual(
    bridgePayloads.map((payload) => ({
      conversationId: payload.conversationId,
      executor: payload.executor,
      mainAgent: payload.mainAgent
    })),
    [
      { conversationId: "conversation-a", executor: "openclaw.gengar", mainAgent: "gengar" },
      { conversationId: "conversation-a", executor: "openclaw.gengar", mainAgent: "gengar" },
      { conversationId: "conversation-a", executor: "openclaw.rowlet", mainAgent: "rowlet" },
      { conversationId: "conversation-b", executor: "openclaw.gengar", mainAgent: "gengar" }
    ]
  )

  const sessionHelper = await loadOpenClawSessionHelper()
  const sessionKeys = bridgePayloads.map((payload) => sessionHelper.deriveOpenClawSessionKey({
    mainAgent: payload.mainAgent,
    conversationId: payload.conversationId
  }))
  assert.equal(sessionKeys[0], sessionKeys[1])
  assert.notEqual(sessionKeys[0], sessionKeys[2])
  assert.notEqual(sessionKeys[0], sessionKeys[3])
})

test("unbound route helper advances conversation history cursor only after successful delivery", async () => {
  const sync = new ConversationHistorySync()
  const capturedHistories: Array<Array<{ role: "user" | "assistant"; content: string }> | undefined> = []
  let attempt = 0
  const invokeAgent = async (input: AgentInvocationInput) => {
    capturedHistories.push(input.conversationHistory)
    attempt += 1
    return {
      status: attempt === 1 ? "failed" as const : "completed" as const,
      body: `reply-${attempt}`
    }
  }

  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation:cursor-check",
    targetAgent: "openclaw.gengar",
    content: "Message 1",
    entries: [
      {
        id: "entry-1",
        role: "user",
        agentId: "openclaw.gengar",
        content: "Message 1"
      }
    ],
    invokeAgent
  })

  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation:cursor-check",
    targetAgent: "openclaw.gengar",
    content: "Message 2",
    entries: [
      {
        id: "entry-1",
        role: "user",
        agentId: "openclaw.gengar",
        content: "Message 1"
      },
      {
        id: "entry-2",
        role: "user",
        agentId: "openclaw.gengar",
        content: "Message 2"
      }
    ],
    invokeAgent
  })

  await routeOpenClawUnboundConversation({
    sync,
    conversationId: "conversation:cursor-check",
    targetAgent: "openclaw.gengar",
    content: "Message 3",
    entries: [
      {
        id: "entry-1",
        role: "user",
        agentId: "openclaw.gengar",
        content: "Message 1"
      },
      {
        id: "entry-2",
        role: "user",
        agentId: "openclaw.gengar",
        content: "Message 2"
      },
      {
        id: "entry-3",
        role: "user",
        agentId: "openclaw.gengar",
        content: "Message 3"
      }
    ],
    invokeAgent
  })

  assert.deepEqual(capturedHistories[0], [
    { role: "user", content: "[openclaw.gengar] Message 1" }
  ])
  assert.deepEqual(capturedHistories[1], [
    { role: "user", content: "[openclaw.gengar] Message 1" },
    { role: "user", content: "[openclaw.gengar] Message 2" }
  ])
  assert.deepEqual(capturedHistories[2], [
    { role: "user", content: "[openclaw.gengar] Message 3" }
  ])
})

test("OpenClaw A2A uses the bounded shared session identity for long conversations", { concurrency: false }, async (t) => {
  await ensureCompiledAlias()
  const { invokeConfiguredAgent } = await import("../lib/agent-bridge") as typeof import("../lib/agent-bridge")
  const commandDir = await mkdtemp(join(tmpdir(), "jormungand-openclaw-a2a-"))
  const commandPath = join(commandDir, "a2a-fixture.mjs")
  await writeFile(commandPath, [
    'import { readFileSync } from "node:fs"',
    'JSON.parse(readFileSync(0, "utf8"))',
    'process.stdout.write(JSON.stringify({ output: JSON.stringify({ sessionKey: process.env.OPENCLAW_A2A_SESSION_KEY, agent: process.env.OPENCLAW_A2A_AGENT }) }))'
  ].join("\n"))
  t.after(async () => rm(commandDir, { recursive: true, force: true }))

  for (const key of [
    "OPENCLAW_BRIDGE_URL",
    "OPENCLAW_A2A_COMMAND",
    "OPENCLAW_A2A_PROTOCOL"
  ]) {
    restoreEnv(t, key)
  }
  process.env.OPENCLAW_A2A_COMMAND = `${quoteCommandArg(process.execPath)} ${quoteCommandArg(commandPath)}`
  delete process.env.OPENCLAW_BRIDGE_URL

  const run = createRun()
  const skill = {
    id: "conversation.unbound",
    eventType: "requirement_intake",
    stage: "intake",
    name: "Unbound agent execution",
    purpose: "Execute the operator request directly without requiring project or workflow binding.",
    trigger: "An operator posted to an unbound conversation.",
    allowedActors: ["openclaw.gengar"],
    inputs: ["recent conversation text", "agent style guidance"],
    outputs: ["agent response and requested execution results"],
    constraints: ["Report execution results and side effects accurately."],
    gates: ["Server authentication and bridge authorization remain required."],
    knowledgeSources: ["persisted unbound conversation"],
    verificationRules: ["Return the agent response and preserve the conversation identity."]
  } satisfies WorkflowEventSkill
  const invoke = (conversationId: string, executor: AgentKind) => invokeConfiguredAgent({
    run: { ...run, selectedAgent: executor },
    executor,
    stage: "intake",
    artifactType: "log",
    title: "Unbound agent execution",
    fallbackBody: "Fallback response",
    conversationId,
    skill: { ...skill, allowedActors: [executor] }
  })

  const longConversationA = `conversation:${"a".repeat(2400)}`
  const longConversationB = `conversation:${"b".repeat(2400)}`
  const results = [
    await invoke(longConversationA, "openclaw.gengar"),
    await invoke(longConversationA, "openclaw.gengar"),
    await invoke(longConversationA, "openclaw.rowlet"),
    await invoke(longConversationB, "openclaw.gengar")
  ]
  const sessionKeys = results.map((result) => {
    assert.equal(result.status, "completed")
    assert.match(result.statusMessage ?? "", /session /)
    const body = JSON.parse(result.body) as { sessionKey?: string; agent?: string }
    assert.equal(body.sessionKey, result.statusMessage?.match(/session (.+) replied\.$/)?.[1])
    assert.ok((body.sessionKey ?? "").length <= 160)
    return body.sessionKey
  })

  assert.equal(sessionKeys[0], sessionKeys[1])
  assert.notEqual(sessionKeys[0], sessionKeys[2])
  assert.notEqual(sessionKeys[0], sessionKeys[3])
})

function quoteCommandArg(value: string) {
  return `"${value.replaceAll('"', '\\"')}"`
}
