import assert from "node:assert/strict"
import { lstat, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { join } from "node:path"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import test from "node:test"
import ts from "typescript"
import type { AgentKind } from "../lib/types"
import type { AgentLiveEvent } from "../lib/agent-live-events"
import type { ConversationEntry } from "../lib/hive-memory/types"
import { createWorkflowRun } from "../lib/workflow"

type AgentLivePreview = {
  events: AgentLiveEvent[]
  reasoning?: string
  status?: string
}

type MergeResult = (
  current: ConversationEntry[],
  optimisticId: string,
  userEntry: ConversationEntry,
  responseEntry?: ConversationEntry
) => ConversationEntry[]

const requireCompiledModule = createRequire(__filename)

async function ensureCompiledAlias() {
  const tmpRoot = join(process.cwd(), ".tmp-tests")
  const scopedRoot = join(tmpRoot, "node_modules", "@")
  const links = [
    { link: join(scopedRoot, "lib"), target: join(tmpRoot, "lib") },
    { link: join(scopedRoot, "components"), target: join(tmpRoot, "components") }
  ]

  await mkdir(scopedRoot, { recursive: true })
  for (const { link, target } of links) {
    const existingLink = await lstat(link).catch(() => undefined)
    const existingTarget = existingLink?.isSymbolicLink()
      ? await realpath(link).catch(() => undefined)
      : undefined
    const expectedRealTarget = await realpath(target).catch(() => undefined)
    if (existingTarget && expectedRealTarget && existingTarget === expectedRealTarget) {
      continue
    }
    if (existingLink) {
      await rm(link, { recursive: true, force: true })
    }
    await symlink(target, link, "junction").catch(async (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    })
  }
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

async function withMergeResultProbe<T>(operation: (mergeResult: MergeResult) => T | Promise<T>) {
  await ensureCompiledAlias()
  const componentPath = join(process.cwd(), ".tmp-tests", "components", "task-conversation.js")
  const probePath = join(process.cwd(), ".tmp-tests", "components", `task-conversation.merge-probe-${process.pid}.cjs`)
  const compiledComponent = await readFile(componentPath, "utf8")
  await writeFile(probePath, `${compiledComponent}\nmodule.exports.mergeResultForTest = mergeResult\n`)

  try {
    const probe = requireCompiledModule(probePath) as { mergeResultForTest?: MergeResult }
    const mergeResult = probe.mergeResultForTest
    assert.equal(typeof mergeResult, "function")
    if (!mergeResult) throw new Error("Compiled conversation merge helper was not exposed by the probe")
    return await operation(mergeResult)
  } finally {
    await rm(probePath, { force: true })
  }
}

async function loadHarnessDashboardModule() {
  await ensureCompiledAlias()
  return await import("../components/harness-dashboard") as typeof import("../components/harness-dashboard") & Record<string, unknown>
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

test("conversation requests preserve the browser receiver for native fetch", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const requestConversationSummaries = Reflect.get(taskConversationModule, "requestConversationSummaries") as
    | ((fetchImpl: typeof fetch) => Promise<unknown>)
    | undefined
  const runConversationHydration = Reflect.get(taskConversationModule, "runConversationHydration") as
    | ((input: Record<string, unknown>) => Promise<unknown>)
    | undefined
  const runConversationControl = Reflect.get(taskConversationModule, "runConversationControl") as
    | ((input: Record<string, unknown>) => Promise<void>)
    | undefined
  const requestConversationDeletion = Reflect.get(taskConversationModule, "requestConversationDeletion") as
    | ((fetchImpl: typeof fetch, conversationId: string) => Promise<void>)
    | undefined

  assert.equal(typeof requestConversationSummaries, "function")
  assert.equal(typeof runConversationHydration, "function")
  assert.equal(typeof runConversationControl, "function")
  assert.equal(typeof requestConversationDeletion, "function")
  if (!requestConversationSummaries || !runConversationHydration || !runConversationControl || !requestConversationDeletion) {
    throw new Error("Conversation request helpers were not exported")
  }

  const receivers: unknown[] = []
  const strictBrowserFetch = async function (
    this: unknown,
    input: RequestInfo | URL,
    init?: RequestInit
  ) {
    receivers.push(this)
    if (this !== globalThis) throw new TypeError("Illegal invocation")

    const path = String(input)
    if (path === "/api/conversations") {
      return jsonResponse({ conversations: [] })
    }
    if (path === "/api/conversation") {
      return jsonResponse({ conversationId: "conversation:receiver", entries: [] })
    }
    if (path === "/api/conversation/control") {
      return jsonResponse({ conversationId: "conversation:receiver", entries: [], events: [] })
    }
    if (path === "/api/conversations/conversation:receiver" && init?.method === "DELETE") {
      return new Response(null, { status: 204 })
    }
    throw new Error(`Unexpected fetch: ${path}`)
  } as typeof fetch

  await requestConversationSummaries(strictBrowserFetch)

  let entries: ConversationEntry[] = []
  const commitEntries = (reconcile: (current: ConversationEntry[]) => ConversationEntry[]) => {
    entries = reconcile(entries)
    return entries
  }
  await runConversationHydration({
    path: "/api/conversation",
    requireConversationId: true,
    generation: 1,
    getCurrentGeneration: () => 1,
    commitEntries,
    fetchImpl: strictBrowserFetch,
    onEntriesChanged: () => undefined
  })
  await runConversationControl({
    action: "stop",
    conversationId: "conversation:receiver",
    commitEntries,
    generation: 1,
    getCurrentGeneration: () => 1,
    fetchImpl: strictBrowserFetch,
    setConversationId: () => undefined,
    setSession: () => undefined,
    setEvents: () => undefined,
    setError: () => undefined,
    setStatusMessage: () => undefined,
    onEntriesChanged: () => undefined
  })
  await requestConversationDeletion(strictBrowserFetch, "conversation:receiver")

  assert.equal(receivers.length, 4)
  assert.equal(receivers.every((receiver) => receiver === globalThis), true)
})

test("unbound Codex model persistence targets the current conversation", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const requestConversationModel = Reflect.get(taskConversationModule, "requestConversationModel") as
    | ((fetchImpl: typeof fetch, conversationId: string, selectedModelId: string) => Promise<unknown>)
    | undefined

  assert.equal(typeof requestConversationModel, "function")

  const calls: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const fetchMock: typeof fetch = async (input, init) => {
    calls.push({ input, init })
    return jsonResponse({
      conversationId: "conversation:current",
      title: "Current conversation",
      state: "active",
      selectedModelId: "gpt-5.6-sol",
      messageCount: 0
    })
  }

  const result = await requestConversationModel!(
    fetchMock,
    "conversation:current",
    "gpt-5.6-sol"
  ) as Record<string, unknown>

  assert.equal(String(calls[0]?.input), "/api/conversations/conversation:current")
  assert.equal(calls[0]?.init?.method, "PATCH")
  assert.deepEqual(
    JSON.parse(String(calls[0]?.init?.body ?? "{}")),
    { selectedModelId: "gpt-5.6-sol" }
  )
  assert.equal(result.selectedModelId, "gpt-5.6-sol")
})

test("unbound message payload sends the selected model only to Codex", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const buildConversationMessagePayload = Reflect.get(taskConversationModule, "buildConversationMessagePayload") as
    | ((input: {
      conversationId: string
      targetAgent: AgentKind
      content: string
      idempotencyKey: string
      selectedModelId?: string
    }) => Record<string, unknown>)
    | undefined

  assert.equal(typeof buildConversationMessagePayload, "function")

  const common = {
    conversationId: "conversation:current",
    content: "Use the selected model.",
    idempotencyKey: "message-1",
    selectedModelId: "gpt-5.6-sol",
    selectedReasoningIntensity: "high"
  }
  assert.deepEqual(buildConversationMessagePayload!({ ...common, targetAgent: "codex" }), {
    ...common,
    targetAgent: "codex"
  })
  assert.deepEqual(
    JSON.parse(JSON.stringify(buildConversationMessagePayload!({
      ...common,
      targetAgent: "mavis"
    }))),
    {
      conversationId: common.conversationId,
      content: common.content,
      idempotencyKey: common.idempotencyKey,
      targetAgent: "mavis"
    }
  )
})

test("unbound model PATCH writes serialize and continue after errors", async () => {
  const harnessDashboardModule = await loadHarnessDashboardModule()
  const queueConversationModelUpdate = Reflect.get(harnessDashboardModule, "queueConversationModelUpdate") as
    | ((queue: { current: Promise<void> }, update: () => Promise<void>) => Promise<void>)
    | undefined

  assert.equal(typeof queueConversationModelUpdate, "function")

  const waitForTurn = () => new Promise<void>((resolve) => setImmediate(resolve))
  const writes: string[] = []
  const requests: Array<{
    model: string
    resolve: () => void
    reject: (error: Error) => void
  }> = []
  const queue = { current: Promise.resolve() }

  function update(model: string) {
    return queueConversationModelUpdate!(queue, () => new Promise<void>((resolve, reject) => {
      requests.push({ model, resolve, reject })
    }).then(() => {
      writes.push(model)
    }))
  }

  const first = update("gpt-5.6-sol")
  const second = update("gpt-5.6-luna")
  await waitForTurn()
  assert.deepEqual(requests.map((request) => request.model), ["gpt-5.6-sol"])

  requests[0]!.resolve()
  await waitForTurn()
  assert.deepEqual(requests.map((request) => request.model), ["gpt-5.6-sol", "gpt-5.6-luna"])
  requests[1]!.resolve()
  await Promise.all([first, second])
  assert.deepEqual(writes, ["gpt-5.6-sol", "gpt-5.6-luna"])

  const errorRequests: Array<{
    model: string
    resolve: () => void
    reject: (error: Error) => void
  }> = []
  const errorWrites: string[] = []
  const errorQueue = { current: Promise.resolve() }
  const failed = queueConversationModelUpdate!(errorQueue, () => new Promise<void>((resolve, reject) => {
    errorRequests.push({ model: "gpt-5.6-sol", resolve, reject })
  }).then(() => {
    errorWrites.push("gpt-5.6-sol")
  }))
  const continued = queueConversationModelUpdate!(errorQueue, () => new Promise<void>((resolve, reject) => {
    errorRequests.push({ model: "gpt-5.6-luna", resolve, reject })
  }).then(() => {
    errorWrites.push("gpt-5.6-luna")
  }))

  await waitForTurn()
  errorRequests[0]!.reject(new Error("first PATCH failed"))
  await assert.rejects(failed, /first PATCH failed/)
  await waitForTurn()
  assert.deepEqual(errorRequests.map((request) => request.model), ["gpt-5.6-sol", "gpt-5.6-luna"])
  errorRequests[1]!.resolve()
  await continued
  assert.deepEqual(errorWrites, ["gpt-5.6-luna"])
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

test("conversation manager lock state stays available while running but blocks active mutations", async () => {
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
  }), false)
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

test("openclaw live reducer keeps reasoning opt-in while status and tool activity stay visible", async () => {
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
    id: "completed-1",
    sequence: 4,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "completed",
    createdAt: "2026-08-20T00:00:03.500Z",
    message: "OpenClaw finished"
  })
  preview = reduceAgentLivePreview!(preview, {
    id: "delta-1",
    sequence: 5,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "assistant_delta",
    createdAt: "2026-08-20T00:00:04.000Z",
    delta: "Partial answer"
  })

  assert.equal(preview.status, "OpenClaw finished")
  assert.equal(preview.reasoning, "Thinking through the repository layout")
  assert.deepEqual(preview.events.map((event) => event.type), ["started", "tool", "completed", "assistant_delta"])
  assert.deepEqual(
    preview.events
      .filter((event) => event.type !== "assistant_delta")
      .map((event) => event.message ?? event.text ?? event.delta),
    ["OpenClaw started", "Running rg", "OpenClaw finished"]
  )
  assert.equal(isAgentLiveTerminal!({
    id: "completed-2",
    sequence: 6,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "completed",
    createdAt: "2026-08-20T00:00:05.000Z",
    message: "done"
  }), true)
})

test("assistant delta aggregation preserves exact whitespace, including whitespace-only chunks", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const collectAgentLiveAssistantText = Reflect.get(taskConversationModule, "collectAgentLiveAssistantText") as
    | ((events: AgentLiveEvent[]) => string | undefined)
    | undefined

  assert.equal(typeof collectAgentLiveAssistantText, "function")
  assert.equal(collectAgentLiveAssistantText!([
    {
      id: "delta-blank",
      sequence: 1,
      conversationId: "conversation-1",
      agentId: "openclaw.rowlet",
      type: "assistant_delta",
      createdAt: "2026-08-20T00:00:01.000Z",
      delta: " \n"
    }
  ]), " \n")
  assert.equal(collectAgentLiveAssistantText!([
    {
      id: "delta-leading",
      sequence: 1,
      conversationId: "conversation-1",
      agentId: "openclaw.rowlet",
      type: "assistant_delta",
      createdAt: "2026-08-20T00:00:01.000Z",
      delta: " hello"
    },
    {
      id: "delta-trailing",
      sequence: 2,
      conversationId: "conversation-1",
      agentId: "openclaw.rowlet",
      type: "assistant_delta",
      createdAt: "2026-08-20T00:00:02.000Z",
      text: " \n"
    }
  ]), " hello \n")
})

test("openclaw live submission lifecycle defers replayed terminal frames until the current POST settles", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const startAgentLiveSubmissionLifecycle = Reflect.get(taskConversationModule, "startAgentLiveSubmissionLifecycle") as
    | (() => { postPending: boolean; terminalEventReceived: boolean })
    | undefined
  const advanceAgentLiveSubmissionLifecycle = Reflect.get(taskConversationModule, "advanceAgentLiveSubmissionLifecycle") as
    | ((
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined,
        event: AgentLiveEvent
      ) => {
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined
        shouldCloseSource: boolean
      })
    | undefined
  const settleAgentLiveSubmissionLifecycle = Reflect.get(taskConversationModule, "settleAgentLiveSubmissionLifecycle") as
    | ((
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined
      ) => {
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined
        shouldCloseSource: boolean
      })
    | undefined

  assert.equal(typeof startAgentLiveSubmissionLifecycle, "function")
  assert.equal(typeof advanceAgentLiveSubmissionLifecycle, "function")
  assert.equal(typeof settleAgentLiveSubmissionLifecycle, "function")

  const pendingLifecycle = startAgentLiveSubmissionLifecycle!()
  const replayedTerminal = advanceAgentLiveSubmissionLifecycle!(pendingLifecycle, {
    id: "completed-old",
    sequence: 9,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "completed",
    createdAt: "2026-08-20T00:00:09.000Z",
    message: "previous run completed"
  })

  assert.equal(replayedTerminal.shouldCloseSource, false)
  assert.deepEqual(replayedTerminal.lifecycle, {
    postPending: true,
    terminalEventReceived: true
  })

  const postSettled = settleAgentLiveSubmissionLifecycle!(replayedTerminal.lifecycle)
  assert.equal(postSettled.shouldCloseSource, true)
  assert.equal(postSettled.lifecycle, undefined)
})

test("openclaw live submission lifecycle keeps the stream open for the current run until its own terminal event arrives", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const startAgentLiveSubmissionLifecycle = Reflect.get(taskConversationModule, "startAgentLiveSubmissionLifecycle") as
    | (() => { postPending: boolean; terminalEventReceived: boolean })
    | undefined
  const advanceAgentLiveSubmissionLifecycle = Reflect.get(taskConversationModule, "advanceAgentLiveSubmissionLifecycle") as
    | ((
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined,
        event: AgentLiveEvent
      ) => {
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined
        shouldCloseSource: boolean
      })
    | undefined
  const settleAgentLiveSubmissionLifecycle = Reflect.get(taskConversationModule, "settleAgentLiveSubmissionLifecycle") as
    | ((
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined
      ) => {
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined
        shouldCloseSource: boolean
      })
    | undefined

  assert.equal(typeof startAgentLiveSubmissionLifecycle, "function")
  assert.equal(typeof advanceAgentLiveSubmissionLifecycle, "function")
  assert.equal(typeof settleAgentLiveSubmissionLifecycle, "function")

  const pendingLifecycle = startAgentLiveSubmissionLifecycle!()
  const startedOutcome = advanceAgentLiveSubmissionLifecycle!(pendingLifecycle, {
    id: "started-new",
    sequence: 10,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "started",
    createdAt: "2026-08-20T00:00:10.000Z",
    message: "current run started"
  })
  assert.equal(startedOutcome.shouldCloseSource, false)
  assert.deepEqual(startedOutcome.lifecycle, {
    postPending: true,
    terminalEventReceived: false
  })

  const postSettled = settleAgentLiveSubmissionLifecycle!(startedOutcome.lifecycle)
  assert.equal(postSettled.shouldCloseSource, false)
  assert.deepEqual(postSettled.lifecycle, {
    postPending: false,
    terminalEventReceived: false
  })

  const terminalOutcome = advanceAgentLiveSubmissionLifecycle!(postSettled.lifecycle, {
    id: "completed-new",
    sequence: 11,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "completed",
    createdAt: "2026-08-20T00:00:11.000Z",
    message: "current run completed"
  })
  assert.equal(terminalOutcome.shouldCloseSource, true)
  assert.equal(terminalOutcome.lifecycle, undefined)
})

test("openclaw live source errors are ignored after a terminal frame until the POST settles", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const startAgentLiveSubmissionLifecycle = Reflect.get(taskConversationModule, "startAgentLiveSubmissionLifecycle") as
    | (() => { postPending: boolean; terminalEventReceived: boolean })
    | undefined
  const advanceAgentLiveSubmissionLifecycle = Reflect.get(taskConversationModule, "advanceAgentLiveSubmissionLifecycle") as
    | ((
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined,
        event: AgentLiveEvent
      ) => {
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined
        shouldCloseSource: boolean
      })
    | undefined
  const shouldIgnoreAgentLiveSourceError = Reflect.get(taskConversationModule, "shouldIgnoreAgentLiveSourceError") as
    | ((lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined) => boolean)
    | undefined
  const settleAgentLiveSubmissionLifecycle = Reflect.get(taskConversationModule, "settleAgentLiveSubmissionLifecycle") as
    | ((
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined
      ) => {
        lifecycle: { postPending: boolean; terminalEventReceived: boolean } | undefined
        shouldCloseSource: boolean
      })
    | undefined

  assert.equal(typeof startAgentLiveSubmissionLifecycle, "function")
  assert.equal(typeof advanceAgentLiveSubmissionLifecycle, "function")
  assert.equal(typeof shouldIgnoreAgentLiveSourceError, "function")
  assert.equal(typeof settleAgentLiveSubmissionLifecycle, "function")

  const pendingLifecycle = startAgentLiveSubmissionLifecycle!()
  assert.equal(shouldIgnoreAgentLiveSourceError!(pendingLifecycle), false)

  const terminalOutcome = advanceAgentLiveSubmissionLifecycle!(pendingLifecycle, {
    id: "completed-before-eof",
    sequence: 12,
    conversationId: "conversation-1",
    agentId: "openclaw.rowlet",
    type: "completed",
    createdAt: "2026-08-20T00:00:12.000Z",
    message: "current run completed"
  })

  assert.equal(terminalOutcome.shouldCloseSource, false)
  assert.deepEqual(terminalOutcome.lifecycle, {
    postPending: true,
    terminalEventReceived: true
  })
  assert.equal(shouldIgnoreAgentLiveSourceError!(terminalOutcome.lifecycle), true)

  const settledOutcome = settleAgentLiveSubmissionLifecycle!(terminalOutcome.lifecycle)
  assert.equal(settledOutcome.shouldCloseSource, true)
  assert.equal(settledOutcome.lifecycle, undefined)
  assert.equal(shouldIgnoreAgentLiveSourceError!(settledOutcome.lifecycle), false)
})

test("codex controls remain available while an OpenClaw preview is active for the same conversation", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const getAgentLivePanelState = Reflect.get(taskConversationModule, "getAgentLivePanelState") as
    | ((input: {
        targetAgent: AgentKind
        liveSourceAgentId?: AgentKind
        liveEventAgentId?: AgentKind
        hasActiveSource: boolean
        hasActiveSubmission: boolean
        status?: string
        reasoning?: string
        eventCount: number
      }) => {
        visible: boolean
        agentId?: AgentKind
      })
    | undefined
  const shouldShowCodexControls = Reflect.get(taskConversationModule, "shouldShowCodexControls") as
    | ((input: {
        hasCodexSession: boolean
        isTurnRunning: boolean
        isPaused: boolean
        sessionStatus?: "idle" | "running" | "paused" | "stopped" | "failed"
      }) => boolean)
    | undefined
  const getConversationActivityViewModel = Reflect.get(taskConversationModule, "getConversationActivityViewModel") as
    | ((input: {
        hasCodexSession: boolean
        isTurnRunning: boolean
        isPaused: boolean
        sessionStatus?: "idle" | "running" | "paused" | "stopped" | "failed"
        agentLivePanelState: {
          visible: boolean
          agentId?: AgentKind
        }
      }) => {
        hasAgentLiveActivity: boolean
        showsCodexControls: boolean
        showsCodexSession: boolean
      })
    | undefined

  assert.equal(typeof getAgentLivePanelState, "function")
  assert.equal(typeof shouldShowCodexControls, "function")
  assert.equal(typeof getConversationActivityViewModel, "function")

  const panel = getAgentLivePanelState!({
    targetAgent: "openclaw.rowlet",
    liveSourceAgentId: "openclaw.rowlet",
    hasActiveSource: true,
    hasActiveSubmission: true,
    status: "Working",
    eventCount: 1
  })

  assert.deepEqual(panel, {
    visible: true,
    agentId: "openclaw.rowlet"
  })
  assert.deepEqual(getConversationActivityViewModel!({
    hasCodexSession: true,
    isTurnRunning: true,
    isPaused: false,
    sessionStatus: "running",
    agentLivePanelState: panel
  }), {
    hasAgentLiveActivity: true,
    showsCodexControls: true,
    showsCodexSession: true
  })
  assert.equal(shouldShowCodexControls!({
    hasCodexSession: true,
    isTurnRunning: true,
    isPaused: false,
    sessionStatus: "running"
  }), true)
  assert.equal(shouldShowCodexControls!({
    hasCodexSession: true,
    isTurnRunning: false,
    isPaused: true,
    sessionStatus: "paused"
  }), true)
  assert.equal(shouldShowCodexControls!({
    hasCodexSession: true,
    isTurnRunning: true,
    isPaused: false,
    sessionStatus: "failed"
  }), false)
})

test("conversation UI keeps bound live panel selection and native Codex session visibility independent", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const getAgentLivePanelState = Reflect.get(taskConversationModule, "getAgentLivePanelState") as
    | ((input: {
        targetAgent: AgentKind
        liveSourceAgentId?: AgentKind
        liveEventAgentId?: AgentKind
        hasActiveSource: boolean
        hasActiveSubmission: boolean
        status?: string
        reasoning?: string
        eventCount: number
      }) => {
        visible: boolean
        agentId?: AgentKind
      })
    | undefined
  const getConversationActivityViewModel = Reflect.get(taskConversationModule, "getConversationActivityViewModel") as
    | ((input: {
        hasCodexSession: boolean
        isTurnRunning: boolean
        isPaused: boolean
        sessionStatus?: "idle" | "running" | "paused" | "stopped" | "failed"
        agentLivePanelState: {
          visible: boolean
          agentId?: AgentKind
        }
      }) => {
        hasAgentLiveActivity: boolean
        showsCodexControls: boolean
        showsCodexSession: boolean
      })
    | undefined

  assert.equal(typeof getAgentLivePanelState, "function")
  assert.equal(typeof getConversationActivityViewModel, "function")

  const panel = getAgentLivePanelState!({
    targetAgent: "codex",
    liveSourceAgentId: "mavis",
    hasActiveSource: true,
    hasActiveSubmission: true,
    status: "Lucky working",
    eventCount: 1
  })

  assert.deepEqual(panel, {
    visible: true,
    agentId: "mavis"
  })
  assert.deepEqual(getConversationActivityViewModel!({
    hasCodexSession: true,
    isTurnRunning: true,
    isPaused: false,
    sessionStatus: "running",
    agentLivePanelState: panel
  }), {
    hasAgentLiveActivity: true,
    showsCodexControls: true,
    showsCodexSession: true
  })
})

test("agent live panel state follows the active live stream instead of the target selector", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const getAgentLivePanelState = Reflect.get(taskConversationModule, "getAgentLivePanelState") as
    | ((input: {
        targetAgent: AgentKind
        liveSourceAgentId?: AgentKind
        liveEventAgentId?: AgentKind
        hasActiveSource: boolean
        hasActiveSubmission: boolean
        status?: string
        reasoning?: string
        eventCount: number
      }) => {
        visible: boolean
        agentId?: AgentKind
      })
    | undefined

  assert.equal(typeof getAgentLivePanelState, "function")

  assert.deepEqual(getAgentLivePanelState!({
    targetAgent: "codex",
    liveSourceAgentId: "openclaw.rowlet",
    hasActiveSource: true,
    hasActiveSubmission: true,
    eventCount: 0
  }), {
    visible: true,
    agentId: "openclaw.rowlet"
  })

  assert.deepEqual(getAgentLivePanelState!({
    targetAgent: "codex",
    liveSourceAgentId: "openclaw.rowlet",
    liveEventAgentId: "openclaw.gengar",
    hasActiveSource: false,
    hasActiveSubmission: false,
    status: "OpenClaw finished",
    reasoning: "Thinking through the final answer",
    eventCount: 2
  }), {
    visible: true,
    agentId: "openclaw.gengar"
  })

  assert.deepEqual(getAgentLivePanelState!({
    targetAgent: "codex",
    liveSourceAgentId: "openclaw.rowlet",
    liveEventAgentId: "openclaw.gengar",
    hasActiveSource: false,
    hasActiveSubmission: true,
    status: "OpenClaw finished",
    reasoning: "Thinking through the final answer",
    eventCount: 2
  }), {
    visible: true,
    agentId: "openclaw.gengar"
  })

  assert.deepEqual(getAgentLivePanelState!({
    targetAgent: "codex",
    hasActiveSource: false,
    hasActiveSubmission: false,
    eventCount: 0
  }), {
    visible: false,
    agentId: undefined
  })
})

test("openclaw live helpers encode the SSE path and bound preview activity", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const buildConversationLivePath = Reflect.get(taskConversationModule, "buildConversationLivePath") as
    | ((conversationId: string) => string)
    | undefined
  const shouldOpenAgentLiveStream = Reflect.get(taskConversationModule, "shouldOpenAgentLiveStream") as
    | ((agentId: AgentKind, isBound?: boolean) => boolean)
    | undefined
  const reduceAgentLivePreview = Reflect.get(taskConversationModule, "reduceAgentLivePreview") as
    | ((input: AgentLivePreview, event: AgentLiveEvent) => AgentLivePreview)
    | undefined

  assert.equal(typeof buildConversationLivePath, "function")
  assert.equal(typeof shouldOpenAgentLiveStream, "function")
  assert.equal(typeof reduceAgentLivePreview, "function")
  assert.equal(buildConversationLivePath!("conversation:alpha/beta"), "/api/conversation/live?conversationId=conversation%3Aalpha%2Fbeta")
  assert.equal(shouldOpenAgentLiveStream!("codex"), false)
  assert.equal(shouldOpenAgentLiveStream!("codex", true), true)
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

test("conversation control controller retains durable Stop entries after a stale running response", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const runConversationControl = Reflect.get(taskConversationModule, "runConversationControl") as
    | ((input: Record<string, unknown>) => Promise<void>)
    | undefined
  const entry = (id: string, status: ConversationEntry["status"]): ConversationEntry => ({
    id,
    workflowRunId: "run-stop-ui",
    role: id === "user" ? "user" : "agent",
    agentId: "codex",
    content: id,
    importance: "normal",
    status,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: id,
    createdAt: "2026-09-02T00:00:00.000Z"
  })

  assert.equal(typeof runConversationControl, "function")
  if (!runConversationControl) throw new Error("Conversation control controller was not exported")

  const runningEntries = [entry("user", "running"), entry("response", "running")]
  const stoppedEntries = [entry("user", "interrupted"), entry("response", "interrupted")]
  let entries = runningEntries
  const commitEntries = (reconcile: (current: ConversationEntry[]) => ConversationEntry[]) => {
    entries = reconcile(entries)
    return entries
  }
  const entryNotifications: ConversationEntry[][] = []
  const statusMessages: Array<string | undefined> = []
  const errors: Array<string | undefined> = []
  const sessions: unknown[] = []
  const events: unknown[] = []
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = []
  const responses = [
    {
      conversationId: "conversation:stop-ui",
      entries: stoppedEntries,
      session: { id: "session-stop", status: "stopped", turnStatus: "interrupted" },
      events: []
    },
    {
      conversationId: "conversation:stop-ui",
      entries: runningEntries,
      session: { id: "session-stop", status: "running", turnStatus: "inProgress" },
      events: []
    }
  ]
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    requests.push({ input, init })
    return new Response(JSON.stringify(responses.shift()), { status: 200, headers: { "Content-Type": "application/json" } })
  }
  const run = async () => runConversationControl({
    action: "stop",
    conversationId: "conversation:stop-ui",
    commitEntries,
    generation: 4,
    getCurrentGeneration: () => 4,
    fetchImpl,
    setConversationId: () => undefined,
    setSession: (next: unknown) => { sessions.push(next) },
    setEvents: (next: unknown) => { events.push(next) },
    setError: (next: string | undefined) => { errors.push(next) },
    setStatusMessage: (next: string | undefined) => { statusMessages.push(next) },
    onEntriesChanged: (next: ConversationEntry[]) => { entryNotifications.push(next) }
  })

  await run()
  const afterStop = entries
  await run()
  const afterStaleResponse = entries

  assert.deepEqual(afterStop.map((item) => item.status), ["interrupted", "interrupted"])
  assert.deepEqual(afterStaleResponse.map((item) => item.status), ["interrupted", "interrupted"])
  assert.deepEqual(entryNotifications.map((notification) => notification.map((item) => item.status)), [
    ["interrupted", "interrupted"],
    ["interrupted", "interrupted"]
  ])
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    action: "stop",
    conversationId: "conversation:stop-ui"
  })
  assert.equal(requests.every((request) => request.input === "/api/conversation/control"), true)
  assert.deepEqual(statusMessages, [undefined, undefined])
  assert.deepEqual(errors, [undefined, undefined])
  assert.equal(sessions.length, 2)
  assert.equal(events.length, 2)
})

test("conversation hydration ignores a deferred running poll after Stop while normal polling still applies", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const runConversationControl = Reflect.get(taskConversationModule, "runConversationControl") as
    | ((input: Record<string, unknown>) => Promise<void>)
    | undefined
  const runConversationHydration = Reflect.get(taskConversationModule, "runConversationHydration") as
    | ((input: Record<string, unknown>) => Promise<unknown>)
    | undefined
  const entry = (id: string, status: ConversationEntry["status"]): ConversationEntry => ({
    id,
    workflowRunId: "run-stop-poll-ui",
    role: id === "user" ? "user" : "agent",
    agentId: "codex",
    content: id,
    importance: "normal",
    status,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: id,
    createdAt: "2026-09-02T00:00:00.000Z"
  })

  assert.equal(typeof runConversationControl, "function")
  assert.equal(typeof runConversationHydration, "function")
  if (!runConversationControl || !runConversationHydration) throw new Error("Conversation control and hydration controllers were not exported")

  const runningEntries = [entry("user", "running"), entry("response", "running")]
  const stoppedEntries = [entry("user", "interrupted"), entry("response", "interrupted")]
  let entries = runningEntries
  const commitEntries = (reconcile: (current: ConversationEntry[]) => ConversationEntry[]) => {
    entries = reconcile(entries)
    return entries
  }
  let generation = 8
  const notifications: ConversationEntry[][] = []
  let resolvePoll: ((response: Response) => void) | undefined
  let markPollStarted: (() => void) | undefined
  const pollStarted = new Promise<void>((resolve) => { markPollStarted = resolve })
  const pendingPoll = runConversationHydration({
    path: "/api/conversation?conversationId=conversation%3Astop-poll-ui",
    requireConversationId: true,
    generation,
    getCurrentGeneration: () => generation,
    commitEntries,
    fetchImpl: async () => {
      markPollStarted?.()
      return await new Promise<Response>((resolve) => { resolvePoll = resolve })
    },
    onEntriesChanged: (next: ConversationEntry[]) => { notifications.push(next) }
  })

  await pollStarted
  await runConversationControl({
    action: "stop",
    conversationId: "conversation:stop-poll-ui",
    commitEntries,
    generation,
    getCurrentGeneration: () => generation,
    fetchImpl: async () => new Response(JSON.stringify({
      conversationId: "conversation:stop-poll-ui",
      entries: stoppedEntries,
      events: []
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    setConversationId: () => undefined,
    setSession: () => undefined,
    setEvents: () => undefined,
    setError: () => undefined,
    setStatusMessage: () => undefined,
    onEntriesChanged: (next: ConversationEntry[]) => { notifications.push(next) },
    onStopConfirmed: () => { generation += 1 }
  })
  resolvePoll?.(new Response(JSON.stringify({
    conversationId: "conversation:stop-poll-ui",
    entries: runningEntries,
    allowedAgents: ["codex"]
  }), { status: 200, headers: { "Content-Type": "application/json" } }))
  assert.equal(await pendingPoll, undefined)
  assert.deepEqual(entries.map((item) => item.status), ["interrupted", "interrupted"])
  assert.deepEqual(notifications.map((items) => items.map((item) => item.status)), [["interrupted", "interrupted"]])

  entries = [entry("user", "queued"), entry("response", "queued")]
  const normalPoll = await runConversationHydration({
    path: "/api/conversation?conversationId=conversation%3Astop-poll-ui",
    requireConversationId: true,
    generation,
    getCurrentGeneration: () => generation,
    commitEntries,
    fetchImpl: async () => new Response(JSON.stringify({
      conversationId: "conversation:stop-poll-ui",
      entries: runningEntries,
      allowedAgents: ["codex"]
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    onEntriesChanged: (next: ConversationEntry[]) => { notifications.push(next) }
  })

  assert.ok(normalPoll)
  assert.deepEqual(entries.map((item) => item.status), ["running", "running"])

  await runConversationControl({
    action: "stop",
    conversationId: "conversation:stop-poll-ui",
    commitEntries,
    generation,
    getCurrentGeneration: () => generation,
    fetchImpl: async () => new Response(JSON.stringify({
      conversationId: "conversation:stop-poll-ui",
      entries: stoppedEntries,
      events: []
    }), { status: 200, headers: { "Content-Type": "application/json" } }),
    setConversationId: () => undefined,
    setSession: () => undefined,
    setEvents: () => undefined,
    setError: () => undefined,
    setStatusMessage: () => undefined,
    onEntriesChanged: (next: ConversationEntry[]) => { notifications.push(next) },
    onStopConfirmed: () => { generation += 1 }
  })
  assert.deepEqual(entries.map((item) => item.status), ["interrupted", "interrupted"])
})

test("conversation hydration commits a stale response against newer entries", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const runConversationHydration = Reflect.get(taskConversationModule, "runConversationHydration") as
    | ((input: Record<string, unknown>) => Promise<unknown>)
    | undefined
  const entry = (id: string, status: ConversationEntry["status"]): ConversationEntry => ({
    id,
    workflowRunId: "run-overlap-hydration-ui",
    role: id === "user" || id === "new-user" ? "user" : "agent",
    agentId: "codex",
    content: id,
    importance: "normal",
    status,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: id,
    createdAt: id === "new-user" ? "2026-09-02T00:00:01.000Z" : "2026-09-02T00:00:00.000Z"
  })

  assert.equal(typeof runConversationHydration, "function")
  if (!runConversationHydration) throw new Error("Conversation hydration controller was not exported")

  const runningEntries = [entry("user", "running"), entry("response", "running")]
  const interruptedEntries = [entry("user", "interrupted"), entry("response", "interrupted")]
  const newEntry = entry("new-user", "queued")
  let entries = runningEntries
  const notifications: ConversationEntry[][] = []
  let resolveResponse: ((response: Response) => void) | undefined
  let markRequestStarted: (() => void) | undefined
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve })
  const commitEntries = (reconcile: (current: ConversationEntry[]) => ConversationEntry[]) => {
    entries = reconcile(entries)
    return entries
  }

  const pendingHydration = runConversationHydration({
    path: "/api/conversation?conversationId=conversation%3Aoverlap-hydration-ui",
    requireConversationId: true,
    generation: 12,
    getCurrentGeneration: () => 12,
    currentEntries: entries,
    commitEntries,
    fetchImpl: async () => {
      markRequestStarted?.()
      return await new Promise<Response>((resolve) => { resolveResponse = resolve })
    },
    setEntries: (next: ConversationEntry[]) => { entries = next },
    onEntriesChanged: (next: ConversationEntry[]) => { notifications.push(next) }
  })

  await requestStarted
  commitEntries(() => interruptedEntries)
  commitEntries((current) => [...current, newEntry])
  resolveResponse?.(jsonResponse({
    conversationId: "conversation:overlap-hydration-ui",
    entries: runningEntries,
    allowedAgents: ["codex"]
  }))
  await pendingHydration

  assert.deepEqual(entries.map((item) => [item.id, item.status]), [
    ["user", "interrupted"],
    ["response", "interrupted"],
    ["new-user", "queued"]
  ])
  assert.deepEqual(notifications, [entries])
})

test("conversation control commits a stale response against newer entries", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const runConversationControl = Reflect.get(taskConversationModule, "runConversationControl") as
    | ((input: Record<string, unknown>) => Promise<void>)
    | undefined
  const entry = (id: string, status: ConversationEntry["status"]): ConversationEntry => ({
    id,
    workflowRunId: "run-overlap-control-ui",
    role: id === "user" || id === "new-user" ? "user" : "agent",
    agentId: "codex",
    content: id,
    importance: "normal",
    status,
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: id,
    createdAt: id === "new-user" ? "2026-09-02T00:00:01.000Z" : "2026-09-02T00:00:00.000Z"
  })

  assert.equal(typeof runConversationControl, "function")
  if (!runConversationControl) throw new Error("Conversation control controller was not exported")

  const runningEntries = [entry("user", "running"), entry("response", "running")]
  const interruptedEntries = [entry("user", "interrupted"), entry("response", "interrupted")]
  const newEntry = entry("new-user", "queued")
  let entries = runningEntries
  const notifications: ConversationEntry[][] = []
  let resolveResponse: ((response: Response) => void) | undefined
  let markRequestStarted: (() => void) | undefined
  const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve })
  const commitEntries = (reconcile: (current: ConversationEntry[]) => ConversationEntry[]) => {
    entries = reconcile(entries)
    return entries
  }

  const pendingControl = runConversationControl({
    action: "resume",
    conversationId: "conversation:overlap-control-ui",
    currentEntries: entries,
    commitEntries,
    generation: 13,
    getCurrentGeneration: () => 13,
    fetchImpl: async () => {
      markRequestStarted?.()
      return await new Promise<Response>((resolve) => { resolveResponse = resolve })
    },
    setConversationId: () => undefined,
    setEntries: (next: ConversationEntry[]) => { entries = next },
    setSession: () => undefined,
    setEvents: () => undefined,
    setError: () => undefined,
    setStatusMessage: () => undefined,
    onEntriesChanged: (next: ConversationEntry[]) => { notifications.push(next) }
  })

  await requestStarted
  commitEntries(() => interruptedEntries)
  commitEntries((current) => [...current, newEntry])
  resolveResponse?.(jsonResponse({
    conversationId: "conversation:overlap-control-ui",
    entries: runningEntries,
    session: { id: "session-overlap", status: "running", turnStatus: "inProgress" },
    events: []
  }))
  await pendingControl

  assert.deepEqual(entries.map((item) => [item.id, item.status]), [
    ["user", "interrupted"],
    ["response", "interrupted"],
    ["new-user", "queued"]
  ])
  assert.deepEqual(notifications, [entries])
})

test("back-to-back hydration commits compose before React renders", async () => {
  const taskConversationModule = await loadTaskConversationModule()
  const runConversationHydration = Reflect.get(taskConversationModule, "runConversationHydration") as
    | ((input: Record<string, unknown>) => Promise<unknown>)
    | undefined
  const entry = (id: string, createdAt: string): ConversationEntry => ({
    id,
    workflowRunId: "run-back-to-back-hydration-ui",
    role: id === "user" ? "user" : "agent",
    agentId: "codex",
    content: id,
    importance: "normal",
    status: id === "user" || id === "response" ? "running" : "queued",
    artifactIds: [],
    memoryIds: [],
    idempotencyKey: id,
    createdAt
  })

  assert.equal(typeof runConversationHydration, "function")
  if (!runConversationHydration) throw new Error("Conversation hydration controller was not exported")

  const currentEntries = [
    entry("user", "2026-09-02T00:00:00.000Z"),
    entry("response", "2026-09-02T00:00:00.000Z")
  ]
  const firstResponseEntries = [...currentEntries, entry("first-response", "2026-09-02T00:00:01.000Z")]
  const secondResponseEntries = [...currentEntries, entry("second-response", "2026-09-02T00:00:02.000Z")]
  let entries = currentEntries
  const notifications: ConversationEntry[][] = []
  const deferredResponses: Array<(response: Response) => void> = []
  let resolveRequestsStarted: (() => void) | undefined
  const requestsStarted = new Promise<void>((resolve) => { resolveRequestsStarted = resolve })
  const commitEntries = (reconcile: (current: ConversationEntry[]) => ConversationEntry[]) => {
    entries = reconcile(entries)
    return entries
  }
  const run = () => runConversationHydration({
    path: "/api/conversation?conversationId=conversation%3Aback-to-back-hydration-ui",
    requireConversationId: true,
    generation: 14,
    getCurrentGeneration: () => 14,
    currentEntries,
    commitEntries,
    fetchImpl: async () => {
      if (deferredResponses.length === 1) resolveRequestsStarted?.()
      return await new Promise<Response>((resolve) => { deferredResponses.push(resolve) })
    },
    setEntries: (next: ConversationEntry[]) => { entries = next },
    onEntriesChanged: (next: ConversationEntry[]) => { notifications.push(next) }
  })

  const first = run()
  const second = run()
  await requestsStarted
  deferredResponses[0]?.(jsonResponse({
    conversationId: "conversation:back-to-back-hydration-ui",
    entries: firstResponseEntries,
    allowedAgents: ["codex"]
  }))
  await first
  deferredResponses[1]?.(jsonResponse({
    conversationId: "conversation:back-to-back-hydration-ui",
    entries: secondResponseEntries,
    allowedAgents: ["codex"]
  }))
  await second

  assert.deepEqual(entries.map((item) => item.id), ["user", "response", "first-response", "second-response"])
  assert.deepEqual(notifications.map((items) => items.map((item) => item.id)), [
    ["user", "response", "first-response"],
    ["user", "response", "first-response", "second-response"]
  ])
})

test("TaskConversation control directly delegates to the controller without an entries overwrite", async () => {
  const sourceText = await readFile(join(process.cwd(), "components", "task-conversation.tsx"), "utf8")
  const source = ts.createSourceFile("task-conversation.tsx", sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let control: ts.FunctionDeclaration | undefined

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "control") {
      control = node
      return
    }
    ts.forEachChild(node, visit)
  }
  ts.forEachChild(source, visit)

  assert.ok(control?.body)
  const body = control.body
  const tryIndex = body.statements.findIndex(ts.isTryStatement)
  assert.notEqual(tryIndex, -1)
  assert.equal(body.statements.slice(0, tryIndex).some(ts.isReturnStatement), false)
  const controlTry = body.statements[tryIndex] as ts.TryStatement
  const delegateIndex = controlTry.tryBlock.statements.findIndex((statement) => (
    ts.isExpressionStatement(statement)
    && ts.isAwaitExpression(statement.expression)
    && ts.isCallExpression(statement.expression.expression)
    && ts.isIdentifier(statement.expression.expression.expression)
    && statement.expression.expression.expression.text === "runConversationControl"
  ))
  assert.notEqual(delegateIndex, -1)
  assert.equal(controlTry.tryBlock.statements.slice(0, delegateIndex).some(ts.isReturnStatement), false)

  let directEntriesWrites = 0
  const inspectControl = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "setEntries") {
      directEntriesWrites += 1
    }
    ts.forEachChild(node, inspectControl)
  }
  inspectControl(body)
  assert.equal(directEntriesWrites, 0)

  let hydrationCalls = 0
  let rawSnapshotEntriesWrites = 0
  const inspectComponent = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "runConversationHydration") {
      hydrationCalls += 1
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "setEntries"
      && ts.isPropertyAccessExpression(node.arguments[0])
      && ts.isIdentifier(node.arguments[0].expression)
      && (node.arguments[0].expression.text === "data" || node.arguments[0].expression.text === "result")
    ) {
      rawSnapshotEntriesWrites += 1
    }
    ts.forEachChild(node, inspectComponent)
  }
  inspectComponent(source)
  assert.equal(hydrationCalls, 1)
  assert.equal(rawSnapshotEntriesWrites, 0)

  const controllerInputTypes = new Map<string, ts.TypeLiteralNode>()
  const controllers: ts.FunctionDeclaration[] = []
  const inspectCommitContract = (node: ts.Node): void => {
    if (
      ts.isTypeAliasDeclaration(node)
      && (node.name.text === "ConversationControlInput" || node.name.text === "ConversationHydrationInput")
      && ts.isTypeLiteralNode(node.type)
    ) {
      controllerInputTypes.set(node.name.text, node.type)
    }
    if (
      ts.isFunctionDeclaration(node)
      && (node.name?.text === "runConversationControl" || node.name?.text === "runConversationHydration")
    ) {
      controllers.push(node)
    }
    ts.forEachChild(node, inspectCommitContract)
  }
  inspectCommitContract(source)
  assert.equal(controllerInputTypes.size, 2)
  for (const inputType of controllerInputTypes.values()) {
    const members = inputType.members
      .filter(ts.isPropertySignature)
      .map((member) => member.name?.getText(source))
    assert.equal(members.includes("currentEntries"), false)
    assert.equal(members.includes("setEntries"), false)
    assert.equal(members.includes("commitEntries"), true)
  }

  let commitCalls = 0
  let staleSnapshotReconciliations = 0
  let directEntriesReplacements = 0
  const inspectControllers = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === "input"
    ) {
      if (node.expression.name.text === "commitEntries") commitCalls += 1
      if (node.expression.name.text === "setEntries") directEntriesReplacements += 1
    }
    if (
      ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "reconcileConversationEntries"
      && ts.isPropertyAccessExpression(node.arguments[0])
      && ts.isIdentifier(node.arguments[0].expression)
      && node.arguments[0].expression.text === "input"
      && node.arguments[0].name.text === "currentEntries"
    ) {
      staleSnapshotReconciliations += 1
    }
    ts.forEachChild(node, inspectControllers)
  }
  for (const controller of controllers) inspectControllers(controller)
  assert.equal(commitCalls, 2)
  assert.equal(staleSnapshotReconciliations, 0)
  assert.equal(directEntriesReplacements, 0)
})

test("immediate conversation POST merge preserves server causal order when timestamps tie", async () => {
  await withMergeResultProbe((mergeResult) => {
    const entry = (id: string, createdAt: string): ConversationEntry => ({
      id,
      workflowRunId: "run-ui-order",
      role: "user",
      content: id,
      importance: "normal",
      status: "completed",
      artifactIds: [],
      memoryIds: [],
      idempotencyKey: id,
      createdAt
    })

    const merged = mergeResult(
      [
        entry("earlier", "2026-09-02T00:00:00.000Z"),
        entry("optimistic", "2026-09-02T00:00:01.000Z"),
        entry("later", "2026-09-02T00:00:02.000Z")
      ],
      "optimistic",
      entry("server-user-z", "2026-09-02T00:00:01.000Z"),
      entry("server-response-a", "2026-09-02T00:00:01.000Z")
    )

    assert.deepEqual(
      merged.map((entry) => entry.id),
      ["earlier", "server-user-z", "server-response-a", "later"]
    )
  })
})
