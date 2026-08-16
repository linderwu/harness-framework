import type {} from "../app/api/conversation/route"
import type {} from "../app/api/conversation/control/route"
import type {} from "../app/api/conversation/new/route"

import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { unboundConversationId } from "../lib/conversation"

async function ensureCompiledAlias() {
  const { mkdir, symlink } = await import("node:fs/promises")
  const tmpRoot = join(process.cwd(), ".tmp-tests")
  const scopedRoot = join(tmpRoot, "node_modules", "@")
  const libLink = join(scopedRoot, "lib")

  await mkdir(scopedRoot, { recursive: true })
  await rm(libLink, { recursive: true, force: true }).catch(() => undefined)
  await symlink(join(tmpRoot, "lib"), libLink, "junction")
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

test("conversation GET falls back to the legacy id and sets a durable cookie", async (t) => {
  const { GET } = await importRouteWithIsolatedDataDir<{
    GET: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/route")
  const response = await GET(new Request("http://localhost/api/conversation"))
  const body = await response.json() as { conversationId?: string }
  const setCookie = response.headers.get("set-cookie") ?? ""

  assert.equal(response.status, 200)
  assert.equal(body.conversationId, unboundConversationId)
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

test("new conversation route returns a server-generated id and durable cookie", async (t) => {
  const { POST } = await importRouteWithIsolatedDataDir<{
    POST: (request: Request) => Promise<Response>
  }>(t, "../app/api/conversation/new/route")
  const response = await POST(new Request("http://localhost/api/conversation/new", {
    method: "POST"
  }))
  const body = await response.json() as { conversationId?: string }
  const setCookie = response.headers.get("set-cookie") ?? ""

  assert.equal(response.status, 200)
  assert.match(body.conversationId ?? "", /^conversation:[0-9a-f-]{36}$/i)
  assert.notEqual(body.conversationId, unboundConversationId)
  assert.match(setCookie, /jormungand-conversation-id=/i)
  assert.match(setCookie, /httponly/i)
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
