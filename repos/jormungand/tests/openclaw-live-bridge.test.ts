import assert from "node:assert/strict"
import http from "node:http"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer as createNetServer } from "node:net"
import { spawn, type ChildProcess } from "node:child_process"
import { createHash } from "node:crypto"
import test from "node:test"
import type { TestContext } from "node:test"

const bridgeScript = join(process.cwd(), "scripts", "openclaw-bridge.mjs")

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

async function createRuntimeSkillLock(
  t: TestContext,
  lockedBundles: Record<string, unknown>[]
) {
  const lockDir = await mkdtemp(join(tmpdir(), "jormungand-openclaw-lock-"))
  const lockPath = join(lockDir, "skill.lock.json")

  t.after(async () => {
    await rm(lockDir, { recursive: true, force: true })
  })

  await writeFile(
    lockPath,
    JSON.stringify({ lockedBundles }, null, 2),
    "utf8"
  )

  return lockPath
}

async function createBundleServer(
  t: TestContext,
  options: { delayMs: number; body: Buffer | string }
) {
  let requestCount = 0
  const server = http.createServer((request, response) => {
    requestCount += 1
    setTimeout(() => {
      response.writeHead(200, {
        "Content-Type": "application/octet-stream"
      })
      response.end(options.body)
    }, options.delayMs)
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

  return {
    url: `http://127.0.0.1:${port}/bundle.tgz`,
    get requestCount() {
      return requestCount
    }
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

function isProcessRunning(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function runCommand(
  command: string,
  args: string[],
  options: { cwd?: string } = {}
) {
  const child = spawn(command, args, {
    cwd: options.cwd,
    stdio: ["ignore", "ignore", "pipe"]
  })
  let stderr = ""

  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", (code) => resolve(code ?? 1))
  })

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `${command} exited with ${exitCode}`)
  }
}

async function createRuntimeSkillBundleArchive(t: TestContext) {
  const archiveDir = await mkdtemp(
    join(tmpdir(), "jormungand-openclaw-runtime-bundle-")
  )
  const bundleDir = join(archiveDir, "bundle")
  const archivePath = join(archiveDir, "bundle.tgz")

  t.after(async () => {
    await rm(archiveDir, { recursive: true, force: true })
  })

  await mkdir(bundleDir, { recursive: true })
  await writeFile(join(bundleDir, "SKILL.md"), "# runtime skill test\n", "utf8")
  await runCommand("tar", ["-czf", archivePath, "-C", bundleDir, "."], {
    cwd: archiveDir
  })

  return readFile(archivePath)
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
      'import { writeFileSync } from "node:fs"',
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
      '  process.stderr.write(`${JSON.stringify({ reasoning_content: "stderr reasoning", delta: "stderr delta", result: { payloads: [{ text: "stderr output" }] } })}\\n`)',
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
      "async function runStructuredNoFinalPayload() {",
      "  writeStdout(JSON.stringify({",
      '    reasoning_content: "private chain of thought",',
      '    request: { message: "do not leak this request" },',
      '    toolArgs: { command: "do not leak this tool" },',
      '    raw: { nested: "still private" }',
      "  }))",
      "}",
      "",
      "async function runAssistantFragmentsNoFinalPayload() {",
      '  writeLine({ reasoning_content: "private reasoning" })',
      '  writeLine({ request: { prompt: "do not leak this request" }, toolArgs: { command: "do not leak this tool" } })',
      '  writeLine({ text: "<think>private analysis</think>Visible assistant answer" })',
      "}",
      "",
      "async function runStructuredLeadingTrailingText() {",
      '  writeLine({ text: "<think>private analysis</think> hello \\n" })',
      "}",
      "",
      "async function runStructuredPayloadWithThinkBlock() {",
      '  writeLine({ result: { payloads: [{ text: "<think>private</think>visible" }] } })',
      "}",
      "",
      "async function runStructuredWhitespaceOnlyText() {",
      '  writeLine({ reasoning_content: "private reasoning" })',
      '  writeLine({ request: { prompt: "do not leak this request" }, toolArgs: { command: "do not leak this tool" } })',
      '  writeLine({ text: "<think>private analysis</think> \\n\\t " })',
      "}",
      "",
      "async function runPlainText() {",
      '  writeStdout("Plain text final output")',
      "}",
      "",
      "async function runSlowStop() {",
      "  writeLine({ reasoning_content: \"starting stop workflow\" })",
      "  await sleep(350)",
      '  writeLine({ result: { payloads: [{ text: "Stopped later" }] } })',
      "}",
      "",
      "async function runRuntimeSkillDocker() {",
      "  if (process.env.FAKE_RUNTIME_SKILL_DOCKER_PID_PATH) {",
      '    writeFileSync(process.env.FAKE_RUNTIME_SKILL_DOCKER_PID_PATH, String(process.pid), "utf8")',
      "  }",
      "  if (process.env.FAKE_RUNTIME_SKILL_DOCKER_STARTED_PATH) {",
      '    writeFileSync(process.env.FAKE_RUNTIME_SKILL_DOCKER_STARTED_PATH, "started", "utf8")',
      "  }",
      '  await sleep(Number(process.env.FAKE_RUNTIME_SKILL_DOCKER_DELAY_MS ?? 5_000))',
      "}",
      "",
      "const main = async () => {",
      '  if (process.argv[2] === "runtime-skill-docker") {',
      "    await runRuntimeSkillDocker()",
      "    return",
      "  }",
      "",
      '  if (mode === "structured-no-final-payload") {',
      "    await runStructuredNoFinalPayload()",
      "    return",
      "  }",
      "",
      '  if (mode === "assistant-fragments-no-final-payload") {',
      "    await runAssistantFragmentsNoFinalPayload()",
      "    return",
      "  }",
      "",
      '  if (mode === "structured-leading-trailing-text") {',
      "    await runStructuredLeadingTrailingText()",
      "    return",
      "  }",
      "",
      '  if (mode === "structured-payload-with-think-block") {',
      "    await runStructuredPayloadWithThinkBlock()",
      "    return",
      "  }",
      "",
      '  if (mode === "structured-whitespace-only-text") {',
      "    await runStructuredWhitespaceOnlyText()",
      "    return",
      "  }",
      "",
      '  if (mode === "plain-text") {',
      "    await runPlainText()",
      "    return",
      "  }",
      "",
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
    JSON.stringify(livePoll.body.events).includes("stderr reasoning"),
    false
  )
  assert.equal(
    JSON.stringify(livePoll.body.events).includes("stderr delta"),
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

  const trailingSlashLivePoll = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/live-events-structured/events/?after=0"
  )
  assert.equal(trailingSlashLivePoll.status, 200)
  assert.deepEqual(trailingSlashLivePoll.body, livePoll.body)

  const runResponse = await runPromise
  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "completed")
  assert.equal(completedRun.output, "Final answer")
  assert.notEqual(completedRun.output, "stderr output")
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
  assert.equal(
    JSON.stringify(completedPoll.body.events).includes("stderr reasoning"),
    false
  )
  assert.equal(
    JSON.stringify(completedPoll.body.events).includes("stderr delta"),
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

test("OpenClaw bridge does not leak raw structured JSON when no final payload text exists", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "structured-no-final-payload",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath])
  })

  const runResponse = await postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "structured-no-final-payload",
    workflowRunId: "workflow-structured-no-final-payload",
    executor: "openclaw.rowlet",
    title: "Structured output without final payload",
    requirement: "Verify the bridge never returns raw private structured stdout."
  })

  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "completed")
  assert.notEqual(
    completedRun.output,
    JSON.stringify({
      reasoning_content: "private chain of thought",
      request: { message: "do not leak this request" },
      toolArgs: { command: "do not leak this tool" },
      raw: { nested: "still private" }
    })
  )
  assert.equal(completedRun.output.includes("private chain of thought"), false)
  assert.equal(completedRun.output.includes("do not leak this request"), false)
  assert.equal(completedRun.output.includes("do not leak this tool"), false)
  assert.equal(completedRun.output.includes("still private"), false)
  assert.match(completedRun.output, /without a final text/i)
})

test("OpenClaw bridge falls back to sanitized assistant fragments when structured records omit a final payload", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "assistant-fragments-no-final-payload",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath])
  })

  const runResponse = await postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "assistant-fragments-no-final-payload",
    workflowRunId: "workflow-assistant-fragments-no-final-payload",
    executor: "openclaw.rowlet",
    title: "Assistant fragments without final payload",
    requirement: "Verify the bridge prefers sanitized assistant fragments over raw structured stdout."
  })

  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "completed")
  assert.equal(completedRun.output, "Visible assistant answer")
  assert.equal(completedRun.output.includes("private analysis"), false)
  assert.equal(completedRun.output.includes("do not leak this request"), false)
  assert.equal(completedRun.output.includes("do not leak this tool"), false)
})

test("OpenClaw bridge preserves exact leading and trailing whitespace for structured assistant text", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "structured-leading-trailing-text",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath])
  })

  const runResponse = await postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "structured-leading-trailing-text",
    workflowRunId: "workflow-structured-leading-trailing-text",
    executor: "openclaw.rowlet",
    title: "Structured assistant text with preserved whitespace",
    requirement: "Verify structured assistant text keeps leading and trailing whitespace exactly."
  })

  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "completed")
  assert.equal(completedRun.output, " hello \n")

  const eventsResponse = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/structured-leading-trailing-text/events?after=0"
  )
  assert.equal(eventsResponse.status, 200)
  assert.ok(
    eventsResponse.body.events.some(
      (event: { type?: string; delta?: string }) =>
        event.type === "assistant_delta" && event.delta === " hello \n"
    )
  )
})

test("OpenClaw bridge strips closed think blocks from structured payload text", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "structured-payload-with-think-block",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath])
  })

  const runResponse = await postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "structured-payload-with-think-block",
    workflowRunId: "workflow-structured-payload-with-think-block",
    executor: "openclaw.rowlet",
    title: "Structured payload text strips think blocks",
    requirement: "Verify closed think blocks are removed from final payload text."
  })

  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "completed")
  assert.equal(completedRun.output, "visible")
  assert.equal(completedRun.output.includes("private"), false)
})

test("OpenClaw bridge keeps whitespace-only structured assistant text without falling back to raw private JSON", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "structured-whitespace-only-text",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath])
  })

  const runResponse = await postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "structured-whitespace-only-text",
    workflowRunId: "workflow-structured-whitespace-only-text",
    executor: "openclaw.rowlet",
    title: "Whitespace-only structured assistant text",
    requirement: "Verify whitespace-only structured assistant text survives sanitization without leaking raw stdout."
  })

  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "completed")
  assert.equal(completedRun.output, " \n\t ")
  assert.equal(completedRun.output.includes("private reasoning"), false)
  assert.equal(completedRun.output.includes("do not leak this request"), false)
  assert.equal(completedRun.output.includes("do not leak this tool"), false)

  const eventsResponse = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/structured-whitespace-only-text/events?after=0"
  )
  assert.equal(eventsResponse.status, 200)
  assert.ok(
    eventsResponse.body.events.some(
      (event: { type?: string; delta?: string }) =>
        event.type === "assistant_delta" && event.delta === " \n\t "
    )
  )
})

test("OpenClaw bridge preserves plain-text final output compatibility", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "plain-text",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath])
  })

  const runResponse = await postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "plain-text-output",
    workflowRunId: "workflow-plain-text-output",
    executor: "openclaw.rowlet",
    title: "Plain text final output",
    requirement: "Verify plain text output remains unchanged."
  })

  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "completed")
  assert.equal(completedRun.output, "Plain text final output")
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

test("OpenClaw bridge expires completed idempotency recovery and live journals after the TTL", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "structured",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath]),
    OPENCLAW_BRIDGE_COMPLETED_RUN_TTL_MS: "50"
  })

  const runResponse = await postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "live-events-expire",
    workflowRunId: "workflow-live-expire",
    executor: "openclaw.rowlet",
    title: "Expire a completed live journal",
    requirement: "Exercise completed run TTL cleanup."
  })

  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "completed")

  const recoveryPath = "/agent-runs/by-idempotency/live-events-expire"
  const eventsPath = `${recoveryPath}/events`

  const recoveryPoll = await getJson(baseUrl, recoveryPath)
  assert.equal(recoveryPoll.status, 200)

  const eventsPoll = await getJson(baseUrl, eventsPath)
  assert.equal(eventsPoll.status, 200)
  assert.equal(eventsPoll.body.status, "completed")

  await waitFor(async () => {
    const [recoveryExpired, eventsExpired] = await Promise.all([
      getJson(baseUrl, recoveryPath),
      getJson(baseUrl, eventsPath)
    ])

    return recoveryExpired.status === 404 && eventsExpired.status === 404
  })
})

test("OpenClaw bridge snapshots failed runtime-skill setup as a failed live journal", { concurrency: false }, async (t) => {
  const { baseUrl } = await startBridge(t, {})

  const runResponse = await postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "live-events-runtime-skill-failure",
    workflowRunId: "workflow-runtime-skill-failure",
    executor: "openclaw.rowlet",
    title: "Fail runtime skill installation",
    requirement: "Exercise runtime skill setup failure journaling.",
    runtimeSkillBundles: [
      {
        id: "missing-bundle",
        version: "1.0.0",
        sourceUrl: "https://example.invalid/bundle.tgz",
        checksum: {
          algorithm: "sha256",
          value: "bad-checksum"
        }
      }
    ]
  })

  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "failed")

  const eventsResponse = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/live-events-runtime-skill-failure/events?after=0"
  )
  assert.equal(eventsResponse.status, 200)
  assert.equal(eventsResponse.body.status, "failed")
  assert.deepEqual(
    eventsResponse.body.events.map((event: { type: string }) => event.type),
    ["failed"]
  )
})

test("OpenClaw bridge keeps a failed live journal when the child process cannot start", { concurrency: false }, async (t) => {
  const { baseUrl } = await startBridge(t, {
    OPENCLAW_DOCKER_COMMAND: "definitely-missing-command"
  })

  const runResponse = await postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "live-events-spawn-error",
    workflowRunId: "workflow-spawn-error",
    executor: "openclaw.rowlet",
    title: "Fail child-process startup",
    requirement: "Exercise startup failure journaling."
  })

  assert.equal(runResponse.status, 500)
  assert.match((await runResponse.json()).error, /definitely-missing-command/i)

  await waitFor(async () => {
    const response = await getJson(
      baseUrl,
      "/agent-runs/by-idempotency/live-events-spawn-error/events?after=0"
    )
    return response.status === 200 && response.body.status === "failed"
  })

  const recoveryResponse = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/live-events-spawn-error"
  )
  assert.equal(recoveryResponse.status, 200)
  assert.equal(recoveryResponse.body.status, "failed")

  const eventsResponse = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/live-events-spawn-error/events?after=0"
  )
  assert.equal(eventsResponse.status, 200)
  assert.equal(eventsResponse.body.status, "failed")
  assert.equal(eventsResponse.body.events.at(-1)?.type, "failed")
})

test("OpenClaw bridge reserves idempotency during runtime-skill setup and releases it after failure", { concurrency: false }, async (t) => {
  const bundleServer = await createBundleServer(t, {
    delayMs: 300,
    body: "slow bundle bytes"
  })
  const runtimeSkillBundle = {
    id: "slow-bundle",
    version: "1.0.0",
    sourceUrl: bundleServer.url,
    checksum: {
      algorithm: "sha256",
      value: "0".repeat(64)
    }
  }
  const lockPath = await createRuntimeSkillLock(t, [runtimeSkillBundle])
  const { baseUrl } = await startBridge(t, {
    OPENCLAW_RUNTIME_SKILL_LOCK: lockPath
  })
  const payload = {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "runtime-skill-setup-race",
    workflowRunId: "workflow-runtime-skill-setup-race",
    executor: "openclaw.rowlet",
    title: "Reserve idempotency during setup",
    requirement: "Exercise the runtime skill setup reservation race.",
    runtimeSkillBundles: [runtimeSkillBundle]
  }

  const firstRunPromise = postRun(baseUrl, payload)
  await waitFor(async () => bundleServer.requestCount > 0)

  const duplicateResponse = await postRun(baseUrl, payload)
  assert.equal(duplicateResponse.status, 409)
  assert.equal((await duplicateResponse.json()).idempotencyKey, payload.idempotencyKey)

  const firstRun = await firstRunPromise
  assert.equal(firstRun.status, 200)
  assert.equal((await firstRun.json()).status, "failed")

  const retryResponse = await postRun(baseUrl, payload)
  assert.equal(retryResponse.status, 200)
  assert.equal((await retryResponse.json()).status, "failed")
})

test("OpenClaw bridge stop is effective during delayed runtime-skill setup", { concurrency: false }, async (t) => {
  const bundleServer = await createBundleServer(t, {
    delayMs: 1_000,
    body: "slow bundle bytes"
  })
  const runtimeSkillBundle = {
    id: "slow-stop-bundle",
    version: "1.0.0",
    sourceUrl: bundleServer.url,
    checksum: {
      algorithm: "sha256",
      value: "0".repeat(64)
    }
  }
  const lockPath = await createRuntimeSkillLock(t, [runtimeSkillBundle])
  const { baseUrl } = await startBridge(t, {
    OPENCLAW_RUNTIME_SKILL_LOCK: lockPath
  })

  const runPromise = postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "runtime-skill-setup-stop",
    workflowRunId: "workflow-runtime-skill-setup-stop",
    executor: "openclaw.rowlet",
    title: "Stop during runtime skill setup",
    requirement: "Exercise stop during runtime skill bundle download.",
    runtimeSkillBundles: [runtimeSkillBundle]
  })

  await waitFor(async () => bundleServer.requestCount > 0)

  const stopResponse = await fetch(
    `${baseUrl}/workflow-runs/workflow-runtime-skill-setup-stop/stop`,
    { method: "POST" }
  )
  assert.equal(stopResponse.status, 200)
  assert.deepEqual(await stopResponse.json(), { ok: true, stopped: true })

  const runResponse = await runPromise
  assert.equal(runResponse.status, 200)
  assert.equal((await runResponse.json()).status, "failed")

  const eventsResponse = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/runtime-skill-setup-stop/events?after=0"
  )
  assert.equal(eventsResponse.status, 200)
  assert.equal(eventsResponse.body.status, "failed")
  assert.equal(eventsResponse.body.events.at(-1)?.type, "failed")
})

test("OpenClaw bridge stop interrupts an in-flight runtime-skill docker exec subprocess", { concurrency: false }, async (t) => {
  const bundleBody = await createRuntimeSkillBundleArchive(t)
  const bundleChecksum = createHash("sha256").update(bundleBody).digest("hex")
  const bundleServer = await createBundleServer(t, {
    delayMs: 50,
    body: bundleBody
  })
  const runtimeSkillBundle = {
    id: "slow-tar-stop-bundle",
    version: "1.0.0",
    sourceUrl: bundleServer.url,
    checksum: {
      algorithm: "sha256",
      value: bundleChecksum
    }
  }
  const lockPath = await createRuntimeSkillLock(t, [runtimeSkillBundle])
  const { fixturePath } = await createFakeDocker(t)
  const runtimeSkillCache = await mkdtemp(
    join(tmpdir(), "jormungand-openclaw-runtime-cache-")
  )
  const dockerStartedPath = join(runtimeSkillCache, "runtime-skill-docker.started")
  const dockerPidPath = join(runtimeSkillCache, "runtime-skill-docker.pid")

  t.after(async () => {
    await rm(runtimeSkillCache, { recursive: true, force: true })
  })

  const { baseUrl } = await startBridge(t, {
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath]),
    OPENCLAW_RUNTIME_SKILL_DOCKER_COMMAND: JSON.stringify([
      process.execPath,
      fixturePath,
      "runtime-skill-docker"
    ]),
    OPENCLAW_RUNTIME_SKILL_LOCK: lockPath,
    OPENCLAW_RUNTIME_SKILL_CACHE: runtimeSkillCache,
    FAKE_RUNTIME_SKILL_DOCKER_STARTED_PATH: dockerStartedPath,
    FAKE_RUNTIME_SKILL_DOCKER_PID_PATH: dockerPidPath,
    FAKE_RUNTIME_SKILL_DOCKER_DELAY_MS: "5000"
  })

  const runPromise = postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "runtime-skill-setup-stop-tar",
    workflowRunId: "workflow-runtime-skill-setup-stop-tar",
    executor: "openclaw.rowlet",
    title: "Stop during runtime skill docker exec",
    requirement: "Exercise stop during runtime skill docker exec.",
    runtimeSkillBundles: [runtimeSkillBundle]
  })

  await waitFor(async () => {
    try {
      await readFile(dockerStartedPath, "utf8")
      return true
    } catch {
      return false
    }
  })

  const stopRequestedAt = Date.now()
  const stopResponse = await fetch(
    `${baseUrl}/workflow-runs/workflow-runtime-skill-setup-stop-tar/stop`,
    { method: "POST" }
  )
  assert.equal(stopResponse.status, 200)
  assert.deepEqual(await stopResponse.json(), { ok: true, stopped: true })

  const runResponse = await Promise.race([
    runPromise,
    new Promise<Response>((_, reject) => {
      setTimeout(() => {
        reject(
          new Error(
            "Timed out waiting for stop to interrupt the runtime-skill docker subprocess."
          )
        )
      }, 1_500)
    })
  ])
  assert.ok(Date.now() - stopRequestedAt < 1_500)
  assert.equal(runResponse.status, 200)

  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "failed")
  assert.equal(completedRun.output, "Runtime skill installation cancelled.")

  const dockerPid = Number((await readFile(dockerPidPath, "utf8")).trim())
  await waitFor(async () => !isProcessRunning(dockerPid), 1_000)

  const eventsResponse = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/runtime-skill-setup-stop-tar/events?after=0"
  )
  assert.equal(eventsResponse.status, 200)
  assert.equal(eventsResponse.body.status, "failed")
  assert.equal(eventsResponse.body.events.at(-1)?.type, "failed")
})

test("OpenClaw bridge stop during spawn-to-cancel handoff kills the child and ends the journal terminally", { concurrency: false }, async (t) => {
  const { commandDir, fixturePath } = await createFakeDocker(t)
  const commandPath = `${commandDir};${process.env.Path ?? process.env.PATH ?? ""}`
  const { baseUrl } = await startBridge(t, {
    PATH: commandPath,
    Path: commandPath,
    FAKE_DOCKER_MODE: "slow-stop",
    OPENCLAW_DOCKER_COMMAND: JSON.stringify([process.execPath, fixturePath]),
    OPENCLAW_TEST_SPAWN_TO_CANCEL_HANDLER_DELAY_MS: "200"
  })

  const runPromise = postRun(baseUrl, {
    protocolVersion: "harness-agent-bridge/v0.3",
    idempotencyKey: "spawn-cancel-handoff-stop",
    workflowRunId: "workflow-spawn-cancel-handoff-stop",
    executor: "openclaw.rowlet",
    title: "Stop during child handoff",
    requirement: "Exercise stop during the spawn-to-cancel registration handoff."
  })

  await waitFor(async () => {
    const response = await getJson(
      baseUrl,
      "/agent-runs/by-idempotency/spawn-cancel-handoff-stop/events?after=0"
    )
    return response.status === 200 && response.body.events?.some(
      (event: { type?: string }) => event.type === "started"
    )
  })

  const stopResponse = await fetch(
    `${baseUrl}/workflow-runs/workflow-spawn-cancel-handoff-stop/stop`,
    { method: "POST" }
  )
  assert.equal(stopResponse.status, 200)
  assert.deepEqual(await stopResponse.json(), { ok: true, stopped: true })

  const runResponse = await runPromise
  assert.equal(runResponse.status, 200)
  const completedRun = await runResponse.json()
  assert.equal(completedRun.status, "failed")
  assert.notEqual(completedRun.output, "Stopped later")
  assert.ok(completedRun.capabilities.includes("live-events"))

  const eventsResponse = await getJson(
    baseUrl,
    "/agent-runs/by-idempotency/spawn-cancel-handoff-stop/events?after=0"
  )
  assert.equal(eventsResponse.status, 200)
  assert.equal(eventsResponse.body.status, "failed")
  assert.equal(eventsResponse.body.events.at(-1)?.type, "failed")
})
