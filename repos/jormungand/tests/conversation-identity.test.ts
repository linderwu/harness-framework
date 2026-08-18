import type {} from "../app/api/conversation/route"
import type {} from "../app/api/conversation/control/route"
import type {} from "../app/api/conversation/new/route"

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { unboundConversationId } from "../lib/conversation"
import {
  isValidConversationId,
  legacyConversationId,
  resolveConversationId
} from "../lib/conversation-identity"

async function ensureCompiledAlias() {
  const { lstat, mkdir, realpath, rm, symlink } = await import("node:fs/promises")
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

async function importRouteWithIsolatedDataDir<T>(
  t: test.TestContext,
  routeModulePath: string
) {
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

function setEnv(key: string, value: string) {
  ;(process.env as Record<string, string | undefined>)[key] = value
}

function assertFreshConversationCookie(setCookie: string, conversationId: string) {
  const encodedValue = setCookie.match(/^[^=]+=([^;]+)/)?.[1]
  assert.equal(decodeURIComponent(encodedValue ?? ""), conversationId)
}

test("conversation identity generates a new active id without cookie or body", () => {
  const resolveActiveConversationId = resolveConversationId as unknown as (input: {
    fallbackToNew: boolean
  }) => { conversationId: string; shouldSetCookie: boolean }
  const identity = resolveActiveConversationId({ fallbackToNew: true })

  assert.match(identity.conversationId, /^conversation:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.notEqual(identity.conversationId, legacyConversationId)
  assert.equal(identity.shouldSetCookie, true)
})

test("legacy conversation id remains valid for migration compatibility", () => {
  assert.equal(isValidConversationId(legacyConversationId), true)
  const identity = resolveConversationId({ bodyConversationId: legacyConversationId })

  assert.equal(identity.conversationId, legacyConversationId)
  assert.equal(identity.shouldSetCookie, true)
})

test("active identity mode rotates both legacy cookie names without sharing the legacy id", () => {
  const resolveActiveIdentity = resolveConversationId as unknown as (input: {
    request: Request
    fallbackToNew: boolean
    legacyMode: "allow" | "rotate" | "reject"
  }) => { conversationId: string; shouldSetCookie: boolean }

  for (const cookieName of ["jormungand-conversation-id", "jormungand_conversation_id"]) {
    const identity = resolveActiveIdentity({
      request: new Request("http://localhost/api/conversation", {
        headers: { Cookie: `${cookieName}=${legacyConversationId}` }
      }),
      fallbackToNew: true,
      legacyMode: "rotate"
    })

    assert.match(identity.conversationId, /^conversation:[0-9a-f-]{36}$/i)
    assert.notEqual(identity.conversationId, legacyConversationId)
    assert.equal(identity.shouldSetCookie, true)
  }
})

test("active identity mode rejects an explicit legacy body while allowing migration mode", () => {
  const resolveActiveIdentity = resolveConversationId as unknown as (input: {
    bodyConversationId: unknown
    legacyMode?: "allow" | "rotate" | "reject"
    legacyBodyMode?: "allow" | "rotate" | "reject"
  }) => { conversationId: string }

  assert.throws(
    () => resolveActiveIdentity({
      bodyConversationId: legacyConversationId,
      legacyMode: "rotate",
      legacyBodyMode: "reject"
    }),
    /legacy conversationId is not allowed/i
  )
  assert.equal(
    resolveActiveIdentity({ bodyConversationId: legacyConversationId }).conversationId,
    legacyConversationId
  )
})

test("conversation GET generates a new active id without a cookie and sets a durable cookie", async (t) => {
  const { GET } = await importRouteWithIsolatedDataDir<{
    GET: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const response = await GET(new Request("http://localhost/api/conversation"))
  const body = await response.json() as { conversationId?: string }
  const setCookie = response.headers.get("set-cookie") ?? ""

  assert.equal(response.status, 200)
  assert.match(body.conversationId ?? "", /^conversation:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.notEqual(body.conversationId, unboundConversationId)
  assert.match(setCookie, /jormungand-conversation-id=/i)
  assert.match(setCookie, /httponly/i)
  assert.match(setCookie, /samesite=lax/i)
})

test("conversation GET honors a validated conversation cookie", async (t) => {
  const { GET } = await importRouteWithIsolatedDataDir<{
    GET: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const conversationId = "conversation:11111111-1111-4111-8111-111111111111"
  const response = await GET(new Request("http://localhost/api/conversation", {
    headers: { Cookie: `jormungand-conversation-id=${conversationId}` }
  }))
  const body = await response.json() as { conversationId?: string }

  assert.equal(response.status, 200)
  assert.equal(body.conversationId, conversationId)
})

test("conversation GET ignores malformed cookie encoding and generates a new active id", async (t) => {
  const { GET } = await importRouteWithIsolatedDataDir<{
    GET: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const response = await GET(new Request("http://localhost/api/conversation", {
    headers: { Cookie: "jormungand-conversation-id=%" }
  }))
  const body = await response.json() as { conversationId?: string }

  assert.equal(response.status, 200)
  assert.match(body.conversationId ?? "", /^conversation:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.notEqual(body.conversationId, unboundConversationId)
  assert.match(response.headers.get("set-cookie") ?? "", /jormungand-conversation-id=/i)
})

test("conversation GET rotates the current legacy cookie instead of sharing it", async (t) => {
  const { GET } = await importRouteWithIsolatedDataDir<{
    GET: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const response = await GET(new Request("http://localhost/api/conversation", {
    headers: { Cookie: `jormungand-conversation-id=${legacyConversationId}` }
  }))
  const body = await response.json() as { conversationId?: string }

  assert.equal(response.status, 200)
  assert.match(body.conversationId ?? "", /^conversation:[0-9a-f-]{36}$/i)
  assert.notEqual(body.conversationId, legacyConversationId)
  assert.match(response.headers.get("set-cookie") ?? "", /jormungand-conversation-id=/i)
  assertFreshConversationCookie(response.headers.get("set-cookie") ?? "", body.conversationId ?? "")
})

test("conversation GET rotates the underscore legacy cookie instead of sharing it", async (t) => {
  const { GET } = await importRouteWithIsolatedDataDir<{
    GET: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const response = await GET(new Request("http://localhost/api/conversation", {
    headers: { Cookie: `jormungand_conversation_id=${legacyConversationId}` }
  }))
  const body = await response.json() as { conversationId?: string }

  assert.equal(response.status, 200)
  assert.match(body.conversationId ?? "", /^conversation:[0-9a-f-]{36}$/i)
  assert.notEqual(body.conversationId, legacyConversationId)
  assert.match(response.headers.get("set-cookie") ?? "", /jormungand-conversation-id=/i)
  assertFreshConversationCookie(response.headers.get("set-cookie") ?? "", body.conversationId ?? "")
})

test("new conversation route returns a server-generated id and durable cookie", async (t) => {
  const { POST } = await importRouteWithIsolatedDataDir<{
    POST: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/new/route")
  const response = await POST(new Request("http://localhost/api/conversation/new", {
    method: "POST"
  }))
  const body = await response.json() as {
    conversationId?: string
    metadata?: {
      conversationId?: string
      title?: string
      state?: string
    }
  }
  const setCookie = response.headers.get("set-cookie") ?? ""

  assert.equal(response.status, 201)
  assert.match(body.conversationId ?? "", /^conversation:[0-9a-f-]{36}$/i)
  assert.notEqual(body.conversationId, unboundConversationId)
  assert.equal(body.metadata?.conversationId, body.conversationId)
  assert.equal(body.metadata?.title, "New conversation")
  assert.equal(body.metadata?.state, "active")
  assert.match(setCookie, /jormungand-conversation-id=/i)
  assert.match(setCookie, /httponly/i)
})

test("conversation cookies become secure and persistent for production HTTPS", async (t) => {
  restoreEnv(t, "NODE_ENV")
  setEnv("NODE_ENV", "production")

  const { GET } = await importRouteWithIsolatedDataDir<{
    GET: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const response = await GET(new Request("https://example.test/api/conversation"))
  const setCookie = response.headers.get("set-cookie") ?? ""

  assert.match(setCookie, /httponly/i)
  assert.match(setCookie, /samesite=lax/i)
  assert.match(setCookie, /secure/i)
  assert.match(setCookie, /max-age=/i)
  assert.match(setCookie, /expires=/i)
})

test("conversation cookies stay non-secure for local HTTP development", async (t) => {
  restoreEnv(t, "NODE_ENV")
  setEnv("NODE_ENV", "development")

  const { GET } = await importRouteWithIsolatedDataDir<{
    GET: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const response = await GET(new Request("http://localhost/api/conversation"))
  const setCookie = response.headers.get("set-cookie") ?? ""

  assert.doesNotMatch(setCookie, /secure/i)
  assert.match(setCookie, /max-age=/i)
  assert.match(setCookie, /expires=/i)
})

test("conversation POST accepts a validated body conversation id and echoes it back", async (t) => {
  restoreEnv(t, "HARNESS_ALLOW_SIMULATED_AGENTS")
  process.env.HARNESS_ALLOW_SIMULATED_AGENTS = "1"

  const { POST } = await importRouteWithIsolatedDataDir<{
    POST: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const conversationId = "conversation:22222222-2222-4222-8222-222222222222"
  const response = await POST(new Request("http://localhost/api/conversation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId,
      content: "Need an isolated OpenClaw follow-up.",
      idempotencyKey: "conversation-post-with-body-id",
      targetAgent: "openclaw.gengar"
    })
  }))
  const body = await response.json() as {
    conversationId?: string
    userEntry?: { workflowRunId?: string }
  }

  assert.equal(response.status, 202)
  assert.equal(body.conversationId, conversationId)
  assert.equal(body.userEntry?.workflowRunId, conversationId)
})

test("conversation POST generates an active id without body or cookie", async (t) => {
  restoreEnv(t, "HARNESS_ALLOW_SIMULATED_AGENTS")
  process.env.HARNESS_ALLOW_SIMULATED_AGENTS = "1"

  const { POST } = await importRouteWithIsolatedDataDir<{
    POST: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const response = await POST(new Request("http://localhost/api/conversation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      content: "Start a fresh active conversation.",
      idempotencyKey: "conversation-post-without-id",
      targetAgent: "openclaw.gengar"
    })
  }))
  const body = await response.json() as {
    conversationId?: string
    userEntry?: { workflowRunId?: string }
  }

  assert.equal(response.status, 202)
  assert.match(body.conversationId ?? "", /^conversation:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i)
  assert.notEqual(body.conversationId, unboundConversationId)
  assert.equal(body.userEntry?.workflowRunId, body.conversationId)
  assert.match(response.headers.get("set-cookie") ?? "", /jormungand-conversation-id=/i)
})

test("conversation POST rejects an explicit legacy body id", async (t) => {
  const { POST } = await importRouteWithIsolatedDataDir<{
    POST: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const response = await POST(new Request("http://localhost/api/conversation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      conversationId: legacyConversationId,
      content: "Do not attach this to the shared legacy session.",
      idempotencyKey: "conversation-post-rejects-legacy"
    })
  }))
  const body = await response.json() as { error?: string }

  assert.equal(response.status, 400)
  assert.match(body.error ?? "", /legacy conversationId is not allowed/i)
})

test("conversation POST rotates either legacy cookie to a fresh active id", async (t) => {
  restoreEnv(t, "HARNESS_ALLOW_SIMULATED_AGENTS")
  process.env.HARNESS_ALLOW_SIMULATED_AGENTS = "1"

  const { POST } = await importRouteWithIsolatedDataDir<{
    POST: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  for (const [index, cookieName] of [
    "jormungand-conversation-id",
    "jormungand_conversation_id"
  ].entries()) {
    const response = await POST(new Request("http://localhost/api/conversation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${cookieName}=${legacyConversationId}`
      },
      body: JSON.stringify({
        content: "Start outside the shared legacy session.",
        idempotencyKey: `conversation-post-rotates-legacy-${index}`,
        targetAgent: "openclaw.gengar"
      })
    }))
    const body = await response.json() as {
      conversationId?: string
      userEntry?: { workflowRunId?: string }
    }

    assert.equal(response.status, 202)
    assert.match(body.conversationId ?? "", /^conversation:[0-9a-f-]{36}$/i)
    assert.notEqual(body.conversationId, legacyConversationId)
    assert.equal(body.userEntry?.workflowRunId, body.conversationId)
    assert.match(response.headers.get("set-cookie") ?? "", /jormungand-conversation-id=/i)
    assertFreshConversationCookie(response.headers.get("set-cookie") ?? "", body.conversationId ?? "")
  }
})

test("conversation control rejects legacy body and cookie identities", async (t) => {
  const { POST } = await importRouteWithIsolatedDataDir<{
    POST: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/control/route")

  const bodyResponse = await POST(new Request("http://localhost/api/conversation/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "resume", conversationId: legacyConversationId })
  }))
  assert.equal(bodyResponse.status, 400)
  assert.match((await bodyResponse.json() as { error?: string }).error ?? "", /legacy conversationId is not allowed/i)

  for (const cookieName of ["jormungand-conversation-id", "jormungand_conversation_id"]) {
    const cookieResponse = await POST(new Request("http://localhost/api/conversation/control", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: `${cookieName}=${legacyConversationId}`
      },
      body: JSON.stringify({ action: "resume" })
    }))
    assert.equal(cookieResponse.status, 400)
    assert.match((await cookieResponse.json() as { error?: string }).error ?? "", /legacy conversationId is not allowed/i)
  }
})
