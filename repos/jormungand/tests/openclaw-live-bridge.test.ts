import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:net"
import { spawn, type ChildProcess } from "node:child_process"
import test from "node:test"
import type { TestContext } from "node:test"

const bridgeScript = join(process.cwd(), "scripts", "openclaw-bridge.mjs")

interface BridgeHandle {
  child: ChildProcess
  baseUrl: string
}

async function getFreePort() {
  const server = createServer()

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

async function createFakeDocker(t: TestContext) {
  const commandDir = await mkdtemp(join(tmpdir(), "jormungand-openclaw-live-"))
  const fixturePath = join(commandDir, "docker-fixture.mjs")

  t.after(async () => {
    await rm(commandDir, { recursive: true, force: true })
  })

  await writeFile(
    fixturePath,
    [
      'const mode = process.env.FAKE_DOCKER_MODE ?? "structured"',
      "const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))",
      "const writeStdout = (value) => process.stdout.write(value)",
      "const writeLine = (value) => writeStdout(`${JSON.stringify(value)}\\n`)",
      "",
      "async function runStructured() {",
      '  writeStdout(\'{"reasoning_content":"partial reasoning\')',
      "  await sleep(300)",
      '  writeStdout(\' completed","toolArgs":{"command":"leak-me"},"request":{"message":"do not leak"},"tokens":99}\\n\')',
      '  process.stderr.write("raw stderr should stay private: token=stderr-secret\\n")',
      "  writeLine({",
      '    reasoning_content: "structured reasoning",',
      '    frame: { arbitrary: "ignore-me" },',
      '    toolArgs: { command: "open secret" },',
      '    request: { message: "do not echo this request" }',
      "  })",
      "  writeLine({ stream: \"thinking\", delta: \"thinking stream\" })",
      '  writeLine({ text: "<think>fallback reasoning</think>final visible answer" })',
      "  await sleep(400)",
      "  for (let index = 0; index < 70; index += 1) {",
      '    writeLine({ delta: `assistant chunk ${index}`, toolArgs: { index }, stderr: "hidden" })',
      "  }",
      '  writeLine({ result: { payloads: [{ text: "Final answer" }] } })',
      "}",
      "",
      "async function runSlowStop() {",
      "  writeLine({ reasoning_content: \"starting stop workflow\" })",
      "  await sleep(350)",
      '  writeLine({ result: { payloads: [{ text: "Stopped later" }] } })',
      "}",
      "",
      "const main = async () => {",
      '  if (mode === "slow-stop") {',
      "    await runSlowStop()",
      "    return",
      "  }",
      "",
      "  await runStructured()",
      "}",
      "",
      "main().catch((error) => {",
      "  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\\n`)",
      "  process.exitCode = 1",
      "})"
    ].join("\n"),
    "utf8"
  )

  return {
    commandDir,
    fixturePath
  }
}

async function startBridge(
  t: TestContext,
  environment: Record<string, string | undefined>
): Promise<BridgeHandle> {
  const port = await getFreePort()
  const child = spawn(process.execPath, [bridgeScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OPENCLAW_BRIDGE_HOST: "127.0.0.1",
      OPENCLAW_BRIDGE_PORT: String(port),
      Path: environment.Path ?? environment.PATH ?? process.env.Path,
      ...environment
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stderr = ""

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  t.after(async () => {
    if (child.exitCode === null && !child.killed) {
      child.kill()
    }

    await Promise.race([
      new Promise<void>((resolve) => child.once("close", () => resolve())),
      new Promise<void>((resolve) => setTimeout(resolve, 2_000))
    ])
  })

  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Bridge exited early: ${stderr || "no stderr"}`)
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      return response.ok
    } catch {
      return false
    }
  })

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`
  }
}

async function getJson(baseUrl: string, pathname: string) {
  const response = await fetch(`${baseUrl}${pathname}`)
  const body = await response.json()

  return {
    status: response.status,
    body
  }
}

function postRun(baseUrl: string, payload: Record<string, unknown>) {
  return fetch(`${baseUrl}/agent-runs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  })
}

test("OpenClaw bridge replays bounded safe live events by idempotency key", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "structured",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath])
  })

  const runPromise = postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "live-events-structured",
    workflowRunId: "workflow-live-events",
    executor: "openclaw.rowlet",
    title: "Run structured live events",
    requirement: "Exercise the bridge live events stream."
  })

  await waitFor(async () => {
    const response = await getJson(
      baseUrl,
      "/agent-runs/by-idempotency/live-events-structured/events?after=0"
    )
    return response.status === 200 && response.body.nextCursor === 1
  })

  const partialPoll = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/live-events-structured/events?after=0"
  )
  assert.equal(partialPoll.status, 200)
  assert.equal(partialPoll.body.status, "running")
  assert.deepEqual(
    partialPoll.body.events.map((event: { type: string }) => event.type),
    ["started"]
  )

  await waitFor(async () => {
    const response = await getJson(
      baseUrl,
      "/agent-runs/by-idempotency/live-events-structured/events?after=0"
    )
    return response.body.events?.some(
      (event: { type?: string; text?: string; delta?: string }) =>
        event.type === "reasoning" &&
        event.text?.includes("structured reasoning")
    )
  })

  const livePoll = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/live-events-structured/events?after=0"
  )
  assert.equal(livePoll.status, 200)
  assert.ok(
    livePoll.body.events.some(
      (event: { type?: string; text?: string }) =>
        event.type === "reasoning" &&
        event.text?.includes("partial reasoning completed")
    )
  )
  assert.ok(
    livePoll.body.events.some(
      (event: { type?: string; text?: string }) =>
        event.type === "reasoning" &&
        event.text?.includes("structured reasoning")
    )
  )
  assert.ok(
    livePoll.body.events.some(
      (event: { type?: string; text?: string }) =>
        event.type === "reasoning" &&
        event.text?.includes("thinking stream")
    )
  )
  assert.ok(
    livePoll.body.events.some(
      (event: { type?: string; text?: string }) =>
        event.type === "reasoning" &&
        event.text?.includes("fallback reasoning")
    )
  )
  assert.equal(
    JSON.stringify(livePoll.body.events).includes("stderr-secret"),
    false
  )
  assert.equal(
    JSON.stringify(livePoll.body.events).includes("open secret"),
    false
  )
  assert.equal(
    JSON.stringify(livePoll.body.events).includes("do not echo this request"),
    false
  )
  assert.equal(
    JSON.stringify(livePoll.body.events).includes("ignore-me"),
    false
  )

  const runResponse = await runPromise
  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "completed")
  assert.equal(completedRun.output, "Final answer")
  assert.ok(completedRun.capabilities.includes("live-events"))

  const completedPoll = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/live-events-structured/events?after=0"
  )
  assert.equal(completedPoll.status, 200)
  assert.equal(completedPoll.body.status, "completed")
  assert.equal(completedPoll.body.id, completedRun.id)
  assert.ok(completedPoll.body.events.length <= 64)
  assert.ok(completedPoll.body.nextCursor > completedPoll.body.events.length)
  assert.ok(
    completedPoll.body.events.some(
      (event: { type?: string; delta?: string }) =>
        event.type === "assistant_delta" &&
        event.delta?.startsWith("assistant chunk ")
    )
  )
  assert.equal(
    completedPoll.body.events.at(-1)?.type,
    "completed"
  )
  assert.equal(
    JSON.stringify(completedPoll.body.events).includes("raw stderr should stay private"),
    false
  )

  const tailPoll = await getJson(
    baseUrl,
    `/agent-runs/by-idempotency/live-events-structured/events?after=${completedPoll.body.nextCursor}`
  )
  assert.equal(tailPoll.status, 200)
  assert.deepEqual(tailPoll.body.events, [])
  assert.equal(tailPoll.body.nextCursor, completedPoll.body.nextCursor)

  const missingPoll = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/unknown-live-events/events?after=0"
  )
  assert.equal(missingPoll.status, 404)
})

test("OpenClaw bridge keeps terminal live events after stop and advertises the capability", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "slow-stop",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath])
  })

  const runPromise = postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "live-events-stop",
    workflowRunId: "workflow-live-stop",
    executor: "openclaw.rowlet",
    title: "Stop a live run",
    requirement: "Exercise the stop endpoint."
  })

  await waitFor(async () => {
    const response = await getJson(
      baseUrl,
      "/agent-runs/by-idempotency/live-events-stop/events?after=0"
    )
    return response.status === 200 && response.body.events?.length >= 1
  })

  const stopResponse = await fetch(
    `${baseUrl}/workflow-runs/workflow-live-stop/stop`,
    { method: "POST" }
  )
  assert.equal(stopResponse.status, 200)
  assert.deepEqual(await stopResponse.json(), { ok: true, stopped: true })

  const runResponse = await runPromise
  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.ok(["completed", "failed"].includes(completedRun.status))
  assert.ok(completedRun.capabilities.includes("live-events"))

  const eventsResponse = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/live-events-stop/events?after=0"
  )
  assert.equal(eventsResponse.status, 200)
  assert.ok(
    eventsResponse.body.events.some(
      (event: { type?: string }) => event.type === "started"
    )
  )
  assert.ok(
    ["completed", "failed"].includes(eventsResponse.body.events.at(-1)?.type)
  )
})
