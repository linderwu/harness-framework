import assert from "node:assert/strict"
import { lstat, mkdir, realpath, rm, symlink } from "node:fs/promises"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import test from "node:test"
import type { AgentKind } from "../lib/types"
import type { AgentLiveEvent } from "../lib/agent-live-events"
import { createWorkflowRun } from "../lib/workflow"

type AgentLivePreview = {
  events: AgentLiveEvent[]
  reasoning?: string
  status?: string
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
  const taskConversationModule = await loadTaskConversationModule()
  const requestConversationSummaries = (taskConversationModule as Record<string, unknown>).requestConversationSummaries as
    | ((fetchImpl: typeof fetch, includeArchived?: boolean) => Promise<unknown>)
    | undefined
  const requestNewConversation = (taskConversationModule as Record<string, unknown>).requestNewConversation as
    | ((fetchImpl: typeof fetch) => Promise<unknown>)
    | undefined
  const requestConversationRename = (taskConversationModule as Record<string, unknown>).requestConversationRename as
    | ((fetchImpl: typeof fetch, conversationId: string, title: string) => Promise<unknown>)
    | undefined
  const requestConversationState = (taskConversationModule as Record<string, unknown>).requestConversationState as
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
  const taskConversationModule = await loadTaskConversationModule()
  const requestConversationDeletionAndReplacement = (taskConversationModule as Record<string, unknown>).requestConversationDeletionAndReplacement as
    | ((fetchImpl: typeof fetch, conversationId: string) => Promise<unknown>)
    | undefined
  const buildConversationSwitchState = (taskConversationModule as Record<string, unknown>).buildConversationSwitchState as
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

test("conversation deletion clears stale state before replacement-create failure leaves the UI without a new identity", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const requestConversationDeletionAndReplacement = (taskConversationModule as Record<string, unknown>).requestConversationDeletionAndReplacement as
    | ((fetchImpl: typeof fetch, conversationId: string) => Promise<unknown>)
    | undefined
  const buildDeletedConversationState = (
    Reflect.get(taskConversationModule, "buildDeletedConversationState")
    ?? Reflect.get((taskConversationModule as { default?: unknown }).default ?? {}, "buildDeletedConversationState")
  ) as
    | (() => Record<string, unknown>)
    | undefined
  const buildReplacementFailureState = (
    Reflect.get(taskConversationModule, "buildReplacementFailureState")
    ?? Reflect.get((taskConversationModule as { default?: unknown }).default ?? {}, "buildReplacementFailureState")
  ) as
    | (() => Record<string, unknown>)
    | undefined
  const shouldSkipUnboundHydration = (
    Reflect.get(taskConversationModule, "shouldSkipUnboundHydration")
    ?? Reflect.get((taskConversationModule as { default?: unknown }).default ?? {}, "shouldSkipUnboundHydration")
  ) as
    | ((input: {
        activeConversationId?: string
        isConversationIdentityUnavailable?: boolean
        isReplacingDeletedConversation: boolean
        isUnbound: boolean
      }) => boolean)
    | undefined
  const isConversationManagerLocked = (
    Reflect.get(taskConversationModule, "isConversationManagerLocked")
    ?? Reflect.get((taskConversationModule as { default?: unknown }).default ?? {}, "isConversationManagerLocked")
  ) as
    | ((input: {
        isLoadingConversation: boolean
        isStartingConversation: boolean
        isReplacingDeletedConversation: boolean
        isConversationIdentityUnavailable?: boolean
        isControlling: boolean
        isTurnRunning: boolean
        activeManagerAction?: "rename" | "archive" | "unarchive" | "delete"
      }) => boolean)
    | undefined

  assert.equal(typeof requestConversationDeletionAndReplacement, "function")
  assert.equal(typeof buildDeletedConversationState, "function")
  assert.equal(typeof buildReplacementFailureState, "function")
  assert.equal(typeof shouldSkipUnboundHydration, "function")
  assert.equal(typeof isConversationManagerLocked, "function")

  assert.deepEqual(buildDeletedConversationState!(), {
    content: "",
    conversationId: undefined,
    entries: [],
    error: undefined,
    events: [],
    isLoadingConversation: true,
    metadata: undefined,
    replacementInProgress: true,
    session: undefined,
    statusMessage: undefined
  })
  assert.deepEqual(buildReplacementFailureState!(), {
    content: "",
    conversationId: undefined,
    entries: [],
    error: undefined,
    events: [],
    isConversationIdentityUnavailable: true,
    isLoadingConversation: false,
    metadata: undefined,
    replacementInProgress: false,
    session: undefined,
    statusMessage: undefined
  })
  assert.equal(shouldSkipUnboundHydration!({
    activeConversationId: undefined,
    isConversationIdentityUnavailable: true,
    isReplacingDeletedConversation: false,
    isUnbound: true
  }), true)
  assert.equal(isConversationManagerLocked!({
    isLoadingConversation: false,
    isStartingConversation: false,
    isReplacingDeletedConversation: false,
    isConversationIdentityUnavailable: true,
    isControlling: false,
    isTurnRunning: false
  }), false)

  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ input, init })
    if (String(input) === "/api/conversations/conversation:delete-me") {
      return new Response(null, { status: 204 })
    }
    if (String(input) === "/api/conversation/new") {
      return jsonResponse({ error: "Replacement create failed" }, 500)
    }
    throw new Error(`Unexpected fetch: ${String(input)}`)
  }

  await assert.rejects(
    () => requestConversationDeletionAndReplacement!(fetchMock, "conversation:delete-me"),
    /Replacement create failed/
  )
  assert.equal(calls.length, 2)
  assert.equal(calls[0]?.init?.method, "DELETE")
  assert.equal(calls[1]?.init?.method, "POST")
})

test("replacement hydration guard skips unbound GET while delete replacement is still in progress", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const shouldSkipUnboundHydration = (
    Reflect.get(taskConversationModule, "shouldSkipUnboundHydration")
    ?? Reflect.get((taskConversationModule as { default?: unknown }).default ?? {}, "shouldSkipUnboundHydration")
  ) as
    | ((input: {
        activeConversationId?: string
        isConversationIdentityUnavailable?: boolean
        isReplacingDeletedConversation: boolean
        isUnbound: boolean
      }) => boolean)
    | undefined

  assert.equal(typeof shouldSkipUnboundHydration, "function")
  assert.equal(shouldSkipUnboundHydration!({
    activeConversationId: undefined,
    isReplacingDeletedConversation: true,
    isUnbound: true
  }), true)
  assert.equal(shouldSkipUnboundHydration!({
    activeConversationId: "conversation:replacement",
    isReplacingDeletedConversation: true,
    isUnbound: true
  }), false)
  assert.equal(shouldSkipUnboundHydration!({
    activeConversationId: undefined,
    isReplacingDeletedConversation: false,
    isUnbound: true
  }), false)
  assert.equal(shouldSkipUnboundHydration!({
    activeConversationId: undefined,
    isConversationIdentityUnavailable: true,
    isReplacingDeletedConversation: false,
    isUnbound: true
  }), true)
})

test("conversation manager lock state disables new conversation while running or controlling", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const isConversationManagerLocked = (
    Reflect.get(taskConversationModule, "isConversationManagerLocked")
    ?? Reflect.get((taskConversationModule as { default?: unknown }).default ?? {}, "isConversationManagerLocked")
  ) as
    | ((input: {
        isLoadingConversation: boolean
        isStartingConversation: boolean
        isReplacingDeletedConversation: boolean
        isConversationIdentityUnavailable?: boolean
        isControlling: boolean
        isTurnRunning: boolean
        activeManagerAction?: "rename" | "archive" | "unarchive" | "delete"
      }) => boolean)
    | undefined

  assert.equal(typeof isConversationManagerLocked, "function")
  assert.equal(isConversationManagerLocked!({
    isLoadingConversation: false,
    isStartingConversation: false,
    isReplacingDeletedConversation: false,
    isControlling: false,
    isTurnRunning: false
  }), false)
  assert.equal(isConversationManagerLocked!({
    isLoadingConversation: false,
    isStartingConversation: false,
    isReplacingDeletedConversation: false,
    isControlling: true,
    isTurnRunning: false
  }), true)
  assert.equal(isConversationManagerLocked!({
    isLoadingConversation: false,
    isStartingConversation: false,
    isReplacingDeletedConversation: false,
    isControlling: false,
    isTurnRunning: true
  }), true)
  assert.equal(isConversationManagerLocked!({
    isLoadingConversation: false,
    isStartingConversation: false,
    isReplacingDeletedConversation: false,
    isControlling: false,
    isTurnRunning: false,
    activeManagerAction: "rename"
  }), true)
  assert.equal(isConversationManagerLocked!({
    isLoadingConversation: false,
    isStartingConversation: false,
    isReplacingDeletedConversation: false,
    isConversationIdentityUnavailable: true,
    isControlling: false,
    isTurnRunning: false
  }), false)
})

test("openclaw live reducer keeps status and reasoning separate from visible activity", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const reduceAgentLivePreview = Reflect.get(taskConversationModule, "reduceAgentLivePreview") as
    | ((input: AgentLivePreview, event: AgentLiveEvent) => AgentLivePreview)
    | undefined
  const isAgentLiveTerminal = Reflect.get(taskConversationModule, "isAgentLiveTerminal") as
    | ((event: AgentLiveEvent) => boolean)
    | undefined

  assert.equal(typeof reduceAgentLivePreview, "function")
  assert.equal(typeof isAgentLiveTerminal, "function")

  let preview: AgentLivePreview = { events: [] }
  preview = reduceAgentLivePreview!(preview, {
    id: "started-1",
    sequence: 1,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "started",
    createdAt: "2026-08-20T00:00:01.000Z",
    message: "OpenClaw started"
  })
  preview = reduceAgentLivePreview!(preview, {
    id: "reasoning-1",
    sequence: 2,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "reasoning",
    createdAt: "2026-08-20T00:00:02.000Z",
    text: "Thinking through the repository layout"
  })
  preview = reduceAgentLivePreview!(preview, {
    id: "tool-1",
    sequence: 3,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "tool",
    createdAt: "2026-08-20T00:00:03.000Z",
    message: "Running rg"
  })
  preview = reduceAgentLivePreview!(preview, {
    id: "delta-1",
    sequence: 4,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "assistant_delta",
    createdAt: "2026-08-20T00:00:04.000Z",
    delta: "Partial answer"
  })

  assert.equal(preview.status, "Running rg")
  assert.equal(preview.reasoning, "Thinking through the repository layout")
  assert.deepEqual(preview.events.map((event) => event.type), ["started", "tool", "assistant_delta"])
  assert.equal(isAgentLiveTerminal!({
    id: "completed-1",
    sequence: 5,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "completed",
    createdAt: "2026-08-20T00:00:05.000Z",
    message: "done"
  }), true)
})

test("openclaw live helpers encode the SSE path and bound preview activity", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const buildConversationLivePath = Reflect.get(taskConversationModule, "buildConversationLivePath") as
    | ((conversationId: string) => string)
    | undefined
  const shouldOpenAgentLiveStream = Reflect.get(taskConversationModule, "shouldOpenAgentLiveStream") as
    | ((agentId: AgentKind) => boolean)
    | undefined
  const reduceAgentLivePreview = Reflect.get(taskConversationModule, "reduceAgentLivePreview") as
    | ((input: AgentLivePreview, event: AgentLiveEvent) => AgentLivePreview)
    | undefined

  assert.equal(typeof buildConversationLivePath, "function")
  assert.equal(typeof shouldOpenAgentLiveStream, "function")
  assert.equal(typeof reduceAgentLivePreview, "function")
  assert.equal(buildConversationLivePath!("conversation:alpha/beta"), "/api/conversation/live?conversationId=conversation%3Aalpha%2Fbeta")
  assert.equal(shouldOpenAgentLiveStream!("codex"), false)
  assert.equal(shouldOpenAgentLiveStream!("openclaw.rowlet"), true)

  let preview: AgentLivePreview = { events: [] }
  for (let index = 0; index < 24; index += 1) {
    preview = reduceAgentLivePreview!(preview, {
      id: `delta-${index}`,
      sequence: index,
      conversationId: "conversation-1",
      agentId: "openclaw.rowlet",
      type: "assistant_delta",
      createdAt: "2026-08-20T00:00:04.000Z",
      delta: `delta-${index}`
    })
  }
  preview = reduceAgentLivePreview!(preview, {
    id: "reasoning-2",
    sequence: 30,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "reasoning",
    createdAt: "2026-08-20T00:00:05.000Z",
    text: "x".repeat(20_000)
  })

  assert.equal(preview.events.length, 18)
  assert.equal(preview.events[0]?.delta, "delta-6")
  assert.equal(preview.reasoning?.length, 8_000)
})
