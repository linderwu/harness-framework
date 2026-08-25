import assert from "node:assert/strict"
import http from "node:http"
import { spawn, type ChildProcess } from "node:child_process"
import { join } from "node:path"
import { createServer as createNetServer } from "node:net"
import test, { type TestContext } from "node:test"

const bridgeScript = join(process.cwd(), "scripts", "lucky-mavis-server.mjs")

interface BridgeHandle {
  child: ChildProcess
  baseUrl: string
}

async function getFreePort() {
  const server = createNetServer()

  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => resolve())
    })

    const address = server.address()
    if (!address || typeof address === "string") {
      throw new Error("Unable to determine a free TCP port.")
    }

    return address.port
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  }
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs = 5_000,
  intervalMs = 50
) {
  const startedAt = Date.now()

  while (Date.now() - startedAt < timeoutMs) {
    if (await predicate()) {
      return
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }

  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function createLuckyBackend(t: TestContext) {
  const server = http.createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404)
      response.end()
      return
    }

    response.writeHead(200, { "Content-Type": "application/json" })
    response.end(JSON.stringify({
      choices: [
        {
          finish_reason: "stop",
          message: {
            content: "<think>private</think>visible</think>"
          }
        }
      ]
    }))
  })

  const port = await getFreePort()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(port, "127.0.0.1", () => resolve())
  })

  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()))
    })
  })

  return `http://127.0.0.1:${port}/v1`
}

async function startLuckyBridge(
  t: TestContext,
  backendUrl: string
): Promise<BridgeHandle> {
  const port = await getFreePort()
  const child = spawn(process.execPath, [bridgeScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HARNESS_BRIDGE_TOKEN: "",
      CODEX_BRIDGE_TOKEN: "",
      LUCKY_BRIDGE_TOKEN: "",
      MINIMAX_BRIDGE_TOKEN: "",
      MINIMAX_GATEWAY_TOKEN: "",
      LUCKY_BACKEND_URL: backendUrl,
      LUCKY_BRIDGE_HOST: "127.0.0.1",
      LUCKY_BRIDGE_PORT: String(port),
      LUCKY_BRIDGE_REPO_ROOT: process.cwd()
    },
    stdio: ["ignore", "ignore", "pipe"]
  })

  let stderr = ""
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  t.after(async () => {
    if (!child.killed) {
      child.kill("SIGTERM")
    }
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve())
      setTimeout(() => resolve(), 3_000)
    })
  })

  const baseUrl = `http://127.0.0.1:${port}`
  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/health`).catch(() => undefined)
    return !!response?.ok
  })

  if (stderr.trim()) {
    assert.fail(stderr.trim())
  }

  return { child, baseUrl }
}

async function submitLuckyRun(baseUrl: string, idempotencyKey: string) {
  const response = await fetch(`${baseUrl}/agent-runs`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      protocolVersion: "harness-agent-bridge/v0.3",
      idempotencyKey,
      workflowRunId: "workflow:lucky-live",
      projectName: "Lucky live bridge",
      repository: "owner/repo",
      requirement: "Verify Lucky output routing.",
      stage: "implementation",
      artifactType: "log",
      title: "Lucky output routing",
      executor: "mavis",
      agentFamily: "minimax",
      mainAgent: "mavis",
      skill: {
        id: "agent_task.response",
        eventType: "implementation_dispatch",
        stage: "implementation",
        name: "Lucky bridge test",
        purpose: "Exercise Lucky bridge output routing.",
        trigger: "Lucky bridge test",
        allowedActors: ["mavis"],
        inputs: ["test input"],
        outputs: ["test output"],
        constraints: [],
        gates: [],
        knowledgeSources: [],
        verificationRules: []
      },
      fallbackBody: "fallback"
    })
  })

  assert.equal(response.status, 202)
}

async function readCompletedRun(baseUrl: string, idempotencyKey: string) {
  let body: Record<string, unknown> | undefined

  await waitFor(async () => {
    const response = await fetch(`${baseUrl}/agent-runs/by-idempotency/${encodeURIComponent(idempotencyKey)}`)
    body = await response.json() as Record<string, unknown>
    return body?.status === "completed"
  })

  return body ?? {}
}

async function readJournal(baseUrl: string, idempotencyKey: string) {
  const response = await fetch(
    `${baseUrl}/agent-runs/by-idempotency/${encodeURIComponent(idempotencyKey)}/events?after=0`
  )
  assert.equal(response.status, 200)
  return await response.json() as {
    events?: Array<Record<string, unknown>>
  }
}

test("Lucky bridge strips closed think blocks from the final response body", { concurrency: false }, async (t) => {
  const backendUrl = await createLuckyBackend(t)
  const { baseUrl } = await startLuckyBridge(t, backendUrl)
  const idempotencyKey = "lucky-think-stripping"

  await submitLuckyRun(baseUrl, idempotencyKey)
  const completedRun = await readCompletedRun(baseUrl, idempotencyKey)

  assert.equal(completedRun.output, "visible")
})

test("Lucky bridge journal emits reasoning and assistant delta records for think-wrapped output", { concurrency: false }, async (t) => {
  const backendUrl = await createLuckyBackend(t)
  const { baseUrl } = await startLuckyBridge(t, backendUrl)
  const idempotencyKey = "lucky-live-records"

  await submitLuckyRun(baseUrl, idempotencyKey)
  await readCompletedRun(baseUrl, idempotencyKey)
  const journal = await readJournal(baseUrl, idempotencyKey)

  assert.ok(
    journal.events?.some(
      (event) => event.type === "reasoning" && event.text === "private"
    )
  )
  assert.ok(
    journal.events?.some(
      (event) => event.type === "assistant_delta" && event.delta === "visible"
    )
  )
})
