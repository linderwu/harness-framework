import assert from "node:assert/strict"
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import test from "node:test"
import type { AgentKind } from "../lib/types"
import { createWorkflowRun } from "../lib/workflow"

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

async function loadTaskConversation() {
  await ensureCompiledAlias()
  const taskConversationModule = await import("../components/task-conversation") as typeof import("../components/task-conversation")
  return taskConversationModule.TaskConversation
}

async function loadTaskConversationModule() {
  await ensureCompiledAlias()
  return await import("../components/task-conversation") as typeof import("../components/task-conversation") & Record<string, unknown>
}

function createRun() {
  return createWorkflowRun({
    projectId: "project-1",
    projectName: "Mission",
    projectType: "hive_mission",
    repository: "owner/repo",
    requirement: "Verify initial conversation hydration",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
}

function renderInitialConversation(
  TaskConversation: ReturnType<typeof loadTaskConversation> extends Promise<infer T> ? T : never,
  run?: ReturnType<typeof createRun>
) {
  return renderToStaticMarkup(createElement(TaskConversation, {
    run,
    initialEntries: [],
    allowedAgents: ["codex"] satisfies AgentKind[],
    onEntriesChanged: () => undefined
  }))
}

function assertInitialHydrationGate(markup: string, label: string) {
  const buttons = markup.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []
  const newConversationButton = buttons.find((button) => button.includes('aria-label="New conversation"'))
  assert.ok(newConversationButton, `${label} must keep the new conversation action identifiable while loading`)
  assert.match(newConversationButton, /disabled=""/)
  assert.match(newConversationButton, /Loading\.\.\./)

  const sendButton = buttons.find((button) => button.includes('class="primaryButton"'))
  assert.ok(sendButton, `${label} must render the Send button`)
  assert.match(sendButton, /disabled=""/)
}

test("actual TaskConversation render keeps Send disabled before an unbound conversation id hydrates", async () => {
  const TaskConversation = await loadTaskConversation()

  // SSR intentionally does not run GET effects or click handlers; this test observes the actual pre-hydration markup.
  const boundMarkup = renderInitialConversation(TaskConversation, createRun())
  const remountedUnboundMarkup = renderInitialConversation(TaskConversation)

  assertInitialHydrationGate(boundMarkup, "bound initial mount")
  assertInitialHydrationGate(remountedUnboundMarkup, "bound-to-unbound remount")
})

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

test("conversation manager helpers use the list, new, rename, and archive routes with normalized payloads", async () => {
  const module = await loadTaskConversationModule()
  const requestConversationSummaries = (module as Record<string, unknown>).requestConversationSummaries as
    | ((fetchImpl: typeof fetch, includeArchived?: boolean) => Promise<unknown>)
    | undefined
  const requestNewConversation = (module as Record<string, unknown>).requestNewConversation as
    | ((fetchImpl: typeof fetch) => Promise<unknown>)
    | undefined
  const requestConversationRename = (module as Record<string, unknown>).requestConversationRename as
    | ((fetchImpl: typeof fetch, conversationId: string, title: string) => Promise<unknown>)
    | undefined
  const requestConversationState = (module as Record<string, unknown>).requestConversationState as
    | ((fetchImpl: typeof fetch, conversationId: string, state: "active" | "archived") => Promise<unknown>)
    | undefined

  assert.equal(typeof requestConversationSummaries, "function")
  assert.equal(typeof requestNewConversation, "function")
  assert.equal(typeof requestConversationRename, "function")
  assert.equal(typeof requestConversationState, "function")

  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ input, init })
    const url = String(input)
    if (url.includes("includeArchived=true")) {
      return jsonResponse({
        conversations: [
          {
            conversationId: "conversation:archived",
            title: "Archived conversation",
            state: "archived",
            messageCount: 4,
            latestMessageAt: "2026-08-18T10:00:00.000Z",
            latestMessage: "Archived update"
          }
        ]
      })
    }
    if (url === "/api/conversation/new") {
      return jsonResponse({
        conversationId: "conversation:new",
        metadata: {
          conversationId: "conversation:new",
          title: "New conversation",
          state: "active"
        }
      }, 201)
    }
    if (url === "/api/conversations/conversation:managed") {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
      if (body.title) {
        return jsonResponse({
          conversationId: "conversation:managed",
          title: body.title,
          state: "active",
          messageCount: 1
        })
      }
      return jsonResponse({
        conversationId: "conversation:managed",
        title: "Managed conversation",
        state: body.state,
        messageCount: 1
      })
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  const summaries = await requestConversationSummaries!(fetchMock, true) as Array<Record<string, unknown>>
  const created = await requestNewConversation!(fetchMock) as Record<string, unknown>
  const renamed = await requestConversationRename!(fetchMock, "conversation:managed", "   Renamed conversation   ") as Record<string, unknown>
  const archived = await requestConversationState!(fetchMock, "conversation:managed", "archived") as Record<string, unknown>
  const restored = await requestConversationState!(fetchMock, "conversation:managed", "active") as Record<string, unknown>

  assert.equal(String(calls[0]?.input), "/api/conversations?includeArchived=true")
  assert.equal(calls[1]?.init?.method, "POST")
  assert.equal(String(calls[1]?.input), "/api/conversation/new")
  assert.equal(calls[2]?.init?.method, "PATCH")
  assert.deepEqual(JSON.parse(String(calls[2]?.init?.body ?? "{}")), { title: "Renamed conversation" })
  assert.deepEqual(JSON.parse(String(calls[3]?.init?.body ?? "{}")), { state: "archived" })
  assert.deepEqual(JSON.parse(String(calls[4]?.init?.body ?? "{}")), { state: "active" })
  assert.equal(summaries[0]?.state, "archived")
  assert.equal(created.conversationId, "conversation:new")
  assert.equal(renamed.title, "Renamed conversation")
  assert.equal(archived.state, "archived")
  assert.equal(restored.state, "active")
})

test("conversation deletion replacement flow confirms deletion, clears stale switch state, and stops on delete errors", async () => {
  const module = await loadTaskConversationModule()
  const requestConversationDeletionAndReplacement = (module as Record<string, unknown>).requestConversationDeletionAndReplacement as
    | ((fetchImpl: typeof fetch, conversationId: string) => Promise<unknown>)
    | undefined
  const buildConversationSwitchState = (module as Record<string, unknown>).buildConversationSwitchState as
    | ((conversationId: string) => Record<string, unknown>)
    | undefined

  assert.equal(typeof requestConversationDeletionAndReplacement, "function")
  assert.equal(typeof buildConversationSwitchState, "function")

  const switchState = buildConversationSwitchState!("conversation:next")
  assert.deepEqual(switchState, {
    conversationId: "conversation:next",
    content: "",
    entries: [],
    error: undefined,
    events: [],
    isLoadingConversation: true,
    session: undefined,
    statusMessage: undefined
  })

  const successCalls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const successFetch: typeof fetch = async (input, init) => {
    successCalls.push({ input, init })
    const url = String(input)
    if (url === "/api/conversations/conversation:delete-me") {
      return new Response(null, { status: 204 })
    }
    if (url === "/api/conversation/new") {
      return jsonResponse({
        conversationId: "conversation:replacement",
        metadata: {
          conversationId: "conversation:replacement",
          title: "New conversation",
          state: "active"
        }
      }, 201)
    }
    throw new Error(`Unexpected fetch: ${url}`)
  }

  const replacement = await requestConversationDeletionAndReplacement!(successFetch, "conversation:delete-me") as Record<string, unknown>
  assert.equal(successCalls.length, 2)
  assert.equal(successCalls[0]?.init?.method, "DELETE")
  assert.deepEqual(JSON.parse(String(successCalls[0]?.init?.body ?? "{}")), { confirm: true })
  assert.equal(String(successCalls[1]?.input), "/api/conversation/new")
  assert.equal(replacement.conversationId, "conversation:replacement")

  let failureCalls = 0
  const failingFetch: typeof fetch = async (input, init) => {
    failureCalls += 1
    if (String(input) === "/api/conversations/conversation:delete-me") {
      return jsonResponse({ error: "Delete failed" }, 409)
    }
    throw new Error(`Unexpected fetch: ${String(input)} ${String(init?.method ?? "")}`)
  }

  await assert.rejects(
    () => requestConversationDeletionAndReplacement!(failingFetch, "conversation:delete-me"),
    /Delete failed/
  )
  assert.equal(failureCalls, 1)
})
