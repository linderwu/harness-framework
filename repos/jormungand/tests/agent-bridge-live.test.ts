import assert from "node:assert/strict"
import test, { type TestContext } from "node:test"

import type { AgentLiveEvent } from "../lib/agent-live-events"
import { createAgentLiveBus } from "../lib/agent-live-bus"
import {
  __resetAgentBridgeTestHooks,
  __setAgentBridgeTestHooks,
  invokeConfiguredAgent
} from "../lib/agent-bridge"
import type { AgentKind, WorkflowEventSkill } from "../lib/types"
import { createWorkflowRun } from "../lib/workflow"

function restoreEnv(t: TestContext, key: string) {
  const previousValue = process.env[key]
  t.after(() => {
    if (previousValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previousValue
    }
  })
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
  intervalMs = 10
) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    if (await predicate()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

const liveSkill = {
  id: "agent_task.response",
  eventType: "implementation_dispatch",
  stage: "implementation",
  name: "Bridge live relay",
  purpose: "Exercise OpenClaw bridge live relaying.",
  trigger: "A live relay test runs.",
  allowedActors: ["openclaw.rowlet"],
  inputs: ["live relay test input"],
  outputs: ["live relay test output"],
  constraints: [],
  gates: [],
  knowledgeSources: [],
  verificationRules: []
} satisfies WorkflowEventSkill

function createOpenClawRun() {
  return createWorkflowRun({
    projectId: "project-openclaw-live",
    projectName: "OpenClaw live relay",
    repository: "owner/repo",
    requirement: "Relay optional bridge events to the in-process live bus.",
    selectedAgent: "openclaw.rowlet" as AgentKind,
    designApprovalActor: "independent_agent",
    verificationApprovalActor: "verification_subagent"
  })
}

function installLiveHooks(t: TestContext) {
  const bus = createAgentLiveBus()
  __setAgentBridgeTestHooks({
    now: () => Date.now(),
    sleep: async () => undefined,
    livePollIntervalMs: 0,
    livePollTimeoutMs: 5_000,
    getLastLiveSequence: (conversationId: string) =>
      bus.getSnapshot(conversationId).lastSequence,
    publishLiveEvent: (event: AgentLiveEvent) => bus.publish(event)
  })
  t.after(() => {
    __resetAgentBridgeTestHooks()
  })
  return bus
}

test("publishes started reasoning and completed before the final OpenClaw POST resolves", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  const bus = installLiveHooks(t)
  const postResponse = createDeferred<Response>()
  let postResolved = false
  const eventRequests: string[] = []

  __setAgentBridgeTestHooks({
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "http://openclaw.test/agent-runs") {
        return postResponse.promise.finally(() => {
          postResolved = true
        })
      }

      eventRequests.push(url)

      if (url.endsWith("/events?after=0")) {
        return jsonResponse({
          status: "running",
          nextCursor: 2,
          events: [
            { id: "bridge-started", sequence: 1, type: "started", message: "Bridge started" },
            { id: "bridge-reasoning", sequence: 2, type: "reasoning", text: "Bridge reasoning" }
          ]
        })
      }

      if (url.endsWith("/events?after=2")) {
        return jsonResponse({
          status: "completed",
          nextCursor: 3,
          events: [
            { id: "bridge-completed", sequence: 3, type: "completed", message: "Bridge completed" }
          ]
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }
  })

  const invokePromise = invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Relay live bridge events",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:live-ordering"
  })

  await waitFor(() => {
    const snapshot = bus.getSnapshot("conversation:live-ordering")
    return snapshot.events.map((event) => event.type).join(",") === "started,reasoning,completed"
  })

  assert.equal(postResolved, false)
  assert.deepEqual(
    bus.getSnapshot("conversation:live-ordering").events.map((event) => event.type),
    ["started", "reasoning", "completed"]
  )
  assert.deepEqual(
    eventRequests.map((url) => new URL(url).searchParams.get("after")),
    ["0", "2"]
  )

  postResponse.resolve(
    jsonResponse({
      id: "bridge-run-1",
      status: "completed",
      output: "Final answer",
      statusMessage: "OpenClaw completed."
    })
  )

  const result = await invokePromise
  assert.equal(result.status, "completed")
  assert.equal(result.body, "Final answer")
})

test("falls back cleanly when the optional bridge events endpoint returns 404", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  const bus = installLiveHooks(t)
  let eventsRequestCount = 0

  __setAgentBridgeTestHooks({
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "http://openclaw.test/agent-runs") {
        return jsonResponse({
          id: "bridge-run-404",
          status: "completed",
          output: "Final answer",
          statusMessage: "OpenClaw completed."
        })
      }

      eventsRequestCount += 1
      return jsonResponse({ error: "not found" }, 404)
    }
  })

  const result = await invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Relay with missing events endpoint",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:live-404"
  })

  assert.equal(result.status, "completed")
  assert.equal(result.body, "Final answer")
  assert.equal(eventsRequestCount, 1)
  assert.deepEqual(
    bus.getSnapshot("conversation:live-404").events.map((event) => event.type),
    ["started", "completed"]
  )
})

test("ignores duplicate or regressed event cursors while continuing from the last forward cursor", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  const bus = installLiveHooks(t)
  const postResponse = createDeferred<Response>()
  const afterValues: string[] = []

  __setAgentBridgeTestHooks({
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "http://openclaw.test/agent-runs") {
        return postResponse.promise
      }

      const after = new URL(url).searchParams.get("after") ?? ""
      afterValues.push(after)

      if (after === "0") {
        return jsonResponse({
          status: "running",
          nextCursor: 2,
          events: [
            { id: "bridge-started", sequence: 1, type: "started" },
            { id: "bridge-reasoning", sequence: 2, type: "reasoning", text: "First reasoning" }
          ]
        })
      }

      if (after === "2" && afterValues.length === 2) {
        return jsonResponse({
          status: "running",
          nextCursor: 1,
          events: [
            { id: "bridge-reasoning", sequence: 2, type: "reasoning", text: "First reasoning" }
          ]
        })
      }

      if (after === "2") {
        return jsonResponse({
          status: "completed",
          nextCursor: 3,
          events: [
            { id: "bridge-completed", sequence: 3, type: "completed", message: "Bridge completed" }
          ]
        })
      }

      throw new Error(`Unexpected fetch: ${url}`)
    }
  })

  const invokePromise = invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Ignore regressed cursors",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:live-cursors"
  })

  await waitFor(() => bus.getSnapshot("conversation:live-cursors").terminal)

  assert.deepEqual(afterValues, ["0", "2", "2"])
  assert.deepEqual(
    bus.getSnapshot("conversation:live-cursors").events.map((event) => event.type),
    ["started", "reasoning", "completed"]
  )

  postResponse.resolve(
    jsonResponse({
      id: "bridge-run-cursors",
      status: "completed",
      output: "Final answer"
    })
  )

  const result = await invokePromise
  assert.equal(result.status, "completed")
})

test("skips live bus publication entirely when conversationId is missing", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  const bus = installLiveHooks(t)
  let eventsRequestCount = 0

  __setAgentBridgeTestHooks({
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "http://openclaw.test/agent-runs") {
        return jsonResponse({
          id: "bridge-run-no-conversation",
          status: "completed",
          output: "Final answer"
        })
      }

      eventsRequestCount += 1
      return jsonResponse({}, 404)
    }
  })

  const result = await invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "No live bus without conversationId",
    fallbackBody: "fallback",
    skill: liveSkill
  })

  assert.equal(result.status, "completed")
  assert.equal(eventsRequestCount, 0)
  assert.deepEqual(
    bus.getSnapshot("conversation:missing").events,
    []
  )
})

test("does not duplicate the terminal live event when the bridge already supplied one", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  const bus = installLiveHooks(t)

  __setAgentBridgeTestHooks({
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "http://openclaw.test/agent-runs") {
        return jsonResponse({
          id: "bridge-run-terminal",
          status: "completed",
          output: "Final answer",
          statusMessage: "OpenClaw completed."
        })
      }

      return jsonResponse({
        status: "completed",
        nextCursor: 2,
        events: [
          { id: "bridge-started", sequence: 1, type: "started", message: "Bridge started" },
          { id: "bridge-completed", sequence: 2, type: "completed", message: "Bridge completed" }
        ]
      })
    }
  })

  const result = await invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Avoid duplicate terminal event",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:live-terminal"
  })

  assert.equal(result.status, "completed")
  const terminalEvents = bus
    .getSnapshot("conversation:live-terminal")
    .events.filter((event) => event.type === "completed")
  assert.equal(terminalEvents.length, 1)
})

test("treats back-to-back submissions in the same workflow run as distinct live lifecycles", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  const bus = installLiveHooks(t)
  const secondPostResponse = createDeferred<Response>()
  const run = createOpenClawRun()
  let submissionCount = 0

  __setAgentBridgeTestHooks({
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "http://openclaw.test/agent-runs") {
        submissionCount += 1
        if (submissionCount === 1) {
          return jsonResponse({
            id: "bridge-run-first",
            status: "completed",
            output: "First answer"
          })
        }

        return secondPostResponse.promise
      }

      return jsonResponse({ error: "not found" }, 404)
    }
  })

  const firstResult = await invokeConfiguredAgent({
    run,
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Repeat live bridge events",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:distinct-lifecycles"
  })

  assert.equal(firstResult.status, "completed")
  assert.equal(
    bus.getSnapshot("conversation:distinct-lifecycles").terminal,
    true
  )

  const secondInvokePromise = invokeConfiguredAgent({
    run,
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Repeat live bridge events",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:distinct-lifecycles"
  })

  await waitFor(() => {
    const snapshot = bus.getSnapshot("conversation:distinct-lifecycles")
    return snapshot.events.filter((event) => event.type === "started").length === 2
  })

  const inFlightSnapshot = bus.getSnapshot("conversation:distinct-lifecycles")
  assert.equal(inFlightSnapshot.terminal, false)
  assert.deepEqual(
    inFlightSnapshot.events.map((event) => event.type),
    ["started", "completed", "started"]
  )
  assert.equal(
    new Set(
      inFlightSnapshot.events
        .filter((event) => event.type === "started")
        .map((event) => event.metadata?.runId)
    ).size,
    2
  )

  secondPostResponse.resolve(
    jsonResponse({
      id: "bridge-run-second",
      status: "completed",
      output: "Second answer"
    })
  )

  const secondResult = await secondInvokePromise
  assert.equal(secondResult.status, "completed")
  assert.deepEqual(
    bus.getSnapshot("conversation:distinct-lifecycles").events.map((event) => event.type),
    ["started", "completed", "started", "completed"]
  )
})

test("ignores a late in-flight events response after the final POST completes and aborts the poll when possible", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  const bus = installLiveHooks(t)
  const deferredEventsResponse = createDeferred<Response>()
  let eventsAbortSignal: AbortSignal | undefined
  let eventsAbortCount = 0

  __setAgentBridgeTestHooks({
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === "http://openclaw.test/agent-runs") {
        return jsonResponse({
          id: "bridge-run-late-events",
          status: "completed",
          output: "Final answer",
          statusMessage: "OpenClaw completed."
        })
      }

      eventsAbortSignal = init?.signal ?? undefined
      if (eventsAbortSignal) {
        eventsAbortSignal.addEventListener("abort", () => {
          eventsAbortCount += 1
        }, { once: true })
      }

      return deferredEventsResponse.promise
    }
  })

  const invokePromise = invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Ignore late in-flight events",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:late-events"
  })

  await waitFor(() => eventsAbortSignal !== undefined)

  const result = await invokePromise
  assert.equal(result.status, "completed")
  assert.equal(result.body, "Final answer")

  await waitFor(() => eventsAbortSignal?.aborted === true)
  assert.equal(eventsAbortCount, 1)

  deferredEventsResponse.resolve(
    jsonResponse({
      status: "completed",
      nextCursor: 3,
      events: [
        { id: "bridge-reasoning-late", sequence: 2, type: "reasoning", text: "Late reasoning must be ignored" },
        { id: "bridge-completed-late", sequence: 3, type: "completed", message: "Late completed must be ignored" }
      ]
    })
  )

  await new Promise((resolve) => setTimeout(resolve, 0))

  const snapshot = bus.getSnapshot("conversation:late-events")
  assert.deepEqual(
    snapshot.events.map((event) => event.type),
    ["started", "completed"]
  )
  assert.equal(
    snapshot.events.some(
      (event) =>
        event.type === "reasoning" &&
        event.text === "Late reasoning must be ignored"
    ),
    false
  )
  assert.equal(
    snapshot.events.filter((event) => event.type === "completed").length,
    1
  )
})

test("preserves exact assistant delta whitespace from bridge live records", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  const bus = installLiveHooks(t)
  const postResponse = createDeferred<Response>()

  __setAgentBridgeTestHooks({
    fetch: async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url === "http://openclaw.test/agent-runs") {
        return postResponse.promise
      }

      return jsonResponse({
        status: "completed",
        nextCursor: 3,
        events: [
          {
            id: "bridge-delta-whitespace",
            sequence: 2,
            type: "assistant_delta",
            message: "\n",
            text: " hello \n",
            delta: " hello \n"
          },
          {
            id: "bridge-completed-whitespace",
            sequence: 3,
            type: "completed",
            message: "Bridge completed"
          }
        ]
      })
    }
  })

  const invokePromise = invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Preserve assistant delta whitespace",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:delta-whitespace"
  })

  await waitFor(() =>
    bus
      .getSnapshot("conversation:delta-whitespace")
      .events.some((event) => event.type === "assistant_delta")
  )

  postResponse.resolve(
    jsonResponse({
      id: "bridge-run-delta-whitespace",
      status: "completed",
      output: "Final answer"
    })
  )

  const result = await invokePromise
  assert.equal(result.status, "completed")

  const assistantDelta = bus
    .getSnapshot("conversation:delta-whitespace")
    .events.find((event) => event.type === "assistant_delta")
  assert.ok(assistantDelta)
  assert.equal(assistantDelta.message, "\n")
  assert.equal(assistantDelta.text, " hello \n")
  assert.equal(assistantDelta.delta, " hello \n")
})

test("preserves exact bridge output whitespace in the final result body", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  installLiveHooks(t)

  __setAgentBridgeTestHooks({
    fetch: async () =>
      jsonResponse({
        id: "bridge-run-output-whitespace",
        status: "completed",
        output: " hello \n",
        statusMessage: "OpenClaw completed."
      })
  })

  const result = await invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Preserve bridge output whitespace",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:output-whitespace"
  })

  assert.equal(result.status, "completed")
  assert.equal(result.body, " hello \n")
})

test("falls back to stderr when the bridge output is exactly empty", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"

  installLiveHooks(t)

  __setAgentBridgeTestHooks({
    fetch: async () =>
      jsonResponse({
        id: "bridge-run-empty-output",
        status: "failed",
        output: "",
        stderr: "Actionable stderr",
        statusMessage: "OpenClaw failed."
      })
  })

  const result = await invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Prefer stderr when output is empty",
    fallbackBody: "fallback",
    skill: liveSkill,
    conversationId: "conversation:empty-output"
  })

  assert.equal(result.status, "failed")
  assert.equal(result.body, "Actionable stderr")
})

test("marks recovery timeout delivery as unknown", { concurrency: false }, async (t) => {
  restoreEnv(t, "OPENCLAW_BRIDGE_URL")
  restoreEnv(t, "AGENT_BRIDGE_RECOVERY_TIMEOUT_MS")
  restoreEnv(t, "AGENT_BRIDGE_RECOVERY_POLL_INTERVAL_MS")
  process.env.OPENCLAW_BRIDGE_URL = "http://openclaw.test"
  process.env.AGENT_BRIDGE_RECOVERY_TIMEOUT_MS = "0"
  process.env.AGENT_BRIDGE_RECOVERY_POLL_INTERVAL_MS = "0"

  __setAgentBridgeTestHooks({
    fetch: async (input: RequestInfo | URL) => {
      assert.equal(String(input), "http://openclaw.test/agent-runs")
      return jsonResponse({ error: "upstream request timed out" }, 524)
    }
  })
  t.after(() => {
    __resetAgentBridgeTestHooks()
  })

  const result = await invokeConfiguredAgent({
    run: createOpenClawRun(),
    executor: "openclaw.rowlet",
    stage: "implementation",
    artifactType: "log",
    title: "Mark ambiguous recovery timeout",
    fallbackBody: "fallback",
    skill: liveSkill
  })

  assert.equal(result.status, "failed")
  assert.equal(result.deliveryState, "unknown")
  assert.match(result.body, /recovery polling did not return a completed result/)
})
