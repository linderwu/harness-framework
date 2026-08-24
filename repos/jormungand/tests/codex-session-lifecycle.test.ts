import assert from "node:assert/strict"
import { spawn, type ChildProcess } from "node:child_process"
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile
} from "node:fs/promises"
import { createServer as createNetServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test, { type TestContext } from "node:test"

const bridgeScript = join(process.cwd(), "scripts", "codex-bridge.mjs")
const fetchTimeoutMs = 10_000
const testTimeoutMs = 30_000

interface BridgeHandle {
  child: ChildProcess
  baseUrl: string
}

interface FixtureHandle {
  fixtureDir: string
  commandPath: string
  recordsDir: string
  registerPid: (pid: number | null | undefined) => void
  syncSpawnRecords: () => Promise<SpawnRecord[]>
}

interface SpawnRecord {
  pid: number
  ppid: number
  argv: string[]
}

interface SessionSnapshot {
  id: string
  threadId: string
  status: string
  turnStatus: string
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function boundedFetch(url: string, init: RequestInit = {}, timeoutMs = fetchTimeoutMs) {
  return fetch(url, {
    ...init,
    signal: AbortSignal.timeout(timeoutMs)
  })
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

    await delay(intervalMs)
  }

  throw new Error(`Timed out after ${timeoutMs}ms`)
}

function isProcessRunning(pid: number) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false
  }

  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function terminatePid(pid: number) {
  if (!isProcessRunning(pid)) {
    return
  }

  try {
    process.kill(pid)
  } catch {
    return
  }

  await waitFor(async () => !isProcessRunning(pid), 1_000, 25).catch(() => {})
}

async function waitForPidExit(pid: number, timeoutMs = 2_000) {
  if (!isProcessRunning(pid)) {
    return
  }

  await waitFor(async () => !isProcessRunning(pid), timeoutMs, 25)
}

async function pathExists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function isRetryableFixtureRemovalError(error: unknown) {
  if (!(error instanceof Error)) {
    return false
  }

  return ["EBUSY", "ENOTEMPTY", "EPERM", "EMFILE", "ENFILE"].includes(
    (error as NodeJS.ErrnoException).code ?? ""
  )
}

async function readSpawnRecords(recordsDir: string) {
  try {
    const entries = await readdir(recordsDir)
    const records = await Promise.all(
      entries
        .filter((entry) => entry.endsWith(".json"))
        .map(async (entry) => {
          const raw = await readFile(join(recordsDir, entry), "utf8")
          return JSON.parse(raw) as SpawnRecord
        })
    )

    return records.sort((left, right) => left.pid - right.pid)
  } catch {
    return []
  }
}

function normalizePid(pid: number | null | undefined): number | null {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 0 ? pid : null
}

function registerPid(ownedPids: Set<number>, pid: number | null | undefined) {
  const normalizedPid = normalizePid(pid)
  if (normalizedPid !== null) {
    ownedPids.add(normalizedPid)
  }
}

async function cleanupOwnedPids(ownedPids: Iterable<number>) {
  const exactPids = Array.from(new Set(ownedPids)).sort((left, right) => right - left)

  for (const pid of exactPids) {
    await terminatePid(pid)
  }

  for (const pid of exactPids) {
    await waitForPidExit(pid).catch(() => {})
    assert.equal(isProcessRunning(pid), false, `fixture-owned pid ${pid} should be gone after cleanup`)
  }
}

async function removeOwnedFixtureRoot(fixtureDir: string) {
  const attempts = 20

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await rm(fixtureDir, { recursive: true, force: true })
      if (!(await pathExists(fixtureDir))) {
        return
      }
    } catch (error) {
      if (!isRetryableFixtureRemovalError(error) || attempt === attempts) {
        throw error
      }
    }

    if (attempt < attempts) {
      await delay(100)
    }
  }
}

async function createSessionFixture(t: TestContext): Promise<FixtureHandle> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "jormungand-codex-session-"))
  const recordsDir = join(fixtureDir, "records")
  const fixturePath = join(fixtureDir, "codex-fixture.mjs")
  const commandPath = join(fixtureDir, "codex.cmd")
  const ownedPids = new Set<number>()

  await mkdir(recordsDir, { recursive: true })

  const syncSpawnRecords = async () => {
    const records = await readSpawnRecords(recordsDir)

    for (const record of records) {
      registerPid(ownedPids, record.pid)
    }

    return records
  }

  t.after(async () => {
    await syncSpawnRecords()
    await cleanupOwnedPids(ownedPids)
    await removeOwnedFixtureRoot(fixtureDir)
    assert.equal(await pathExists(fixtureDir), false, `fixture root ${fixtureDir} should be removed`)
  })

  await writeFile(
    fixturePath,
    [
      'import { mkdirSync, writeFileSync } from "node:fs"',
      'import { join } from "node:path"',
      "",
      "const recordsDir = process.env.FIXTURE_RECORDS_DIR",
      'const threadStartDelayMs = Number(process.env.FIXTURE_THREAD_START_DELAY_MS ?? "0")',
      "if (!recordsDir) {",
      '  throw new Error("Missing fixture records directory.")',
      "}",
      "",
      "mkdirSync(recordsDir, { recursive: true })",
      "const record = {",
      "  pid: process.pid,",
      "  ppid: process.ppid,",
      "  argv: process.argv.slice(2)",
      "}",
      'writeFileSync(join(recordsDir, `${process.pid}.json`), JSON.stringify(record, null, 2), "utf8")',
      "",
      "const hold = setInterval(() => {}, 30_000)",
      "const stop = () => {",
      "  clearInterval(hold)",
      "  process.exit(0)",
      "}",
      'process.on("SIGTERM", stop)',
      'process.on("SIGINT", stop)',
      "",
      "let buffer = \"\"",
      'process.stdin.setEncoding("utf8")',
      'const writeMessage = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)',
      'const writeDelayedMessage = (message, delayMs = 0) => {',
      "  if (delayMs > 0) {",
      "    setTimeout(() => writeMessage(message), delayMs)",
      "    return",
      "  }",
      "  writeMessage(message)",
      "}",
      'process.stdin.on("data", (chunk) => {',
      "  buffer += chunk",
      "  const lines = buffer.split(/\\r?\\n/)",
      "  buffer = lines.pop() ?? \"\"",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue",
      "    const message = JSON.parse(line)",
      '    if (message.method === "initialized") continue',
      "    if (message.id === undefined) continue",
      '    if (message.method === "initialize") {',
      '      writeMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "session-fixture", version: "0.1.0" } } })',
      "      continue",
      "    }",
      '    if (message.method === "thread/start") {',
      '      writeDelayedMessage({ jsonrpc: "2.0", id: message.id, result: { thread: { id: `thread-${process.pid}`, status: "idle" } } }, threadStartDelayMs)',
      "      continue",
      "    }",
      '    if (message.method === "thread/resume") {',
      '      writeDelayedMessage({ jsonrpc: "2.0", id: message.id, result: { thread: { id: message.params?.threadId ?? `thread-${process.pid}`, status: "idle" } } }, threadStartDelayMs)',
      "      continue",
      "    }",
      '    if (message.method === "thread/delete") {',
      '      writeMessage({ jsonrpc: "2.0", id: message.id, result: {} })',
      "      continue",
      "    }",
      '    writeMessage({ jsonrpc: "2.0", id: message.id, error: { message: `Unexpected method: ${message.method}` } })',
      "  }",
      "})"
    ].join("\n"),
    "utf8"
  )

  await writeFile(
    commandPath,
    ['@echo off', 'node "%~dp0codex-fixture.mjs" %*', ""].join("\r\n"),
    "utf8"
  )

  return {
    fixtureDir,
    commandPath,
    recordsDir,
    registerPid: (pid) => registerPid(ownedPids, pid),
    syncSpawnRecords
  }
}

async function startBridge(
  t: TestContext,
  fixture: FixtureHandle,
  envOverrides: Record<string, string> = {}
): Promise<BridgeHandle> {
  const port = await getFreePort()
  const child = spawn(process.execPath, [bridgeScript], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      CODEX_BRIDGE_HOST: "127.0.0.1",
      CODEX_BRIDGE_PORT: String(port),
      CODEX_BRIDGE_COMMAND: fixture.commandPath,
      HARNESS_BRIDGE_TOKEN: "",
      FIXTURE_RECORDS_DIR: fixture.recordsDir,
      PATH: process.env.PATH,
      Path: process.env.Path ?? process.env.PATH,
      ...envOverrides
    },
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stderr = ""
  let stdout = ""

  child.stdout?.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr?.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  fixture.registerPid(child.pid)
  assert.ok((child.pid ?? 0) > 0, "bridge pid should be recorded")

  t.after(async () => {
    await terminatePid(child.pid ?? -1)
    await waitForPidExit(child.pid ?? -1).catch(() => {})
  })

  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Bridge exited early: ${stderr || "no stderr"}`)
    }

    if (stdout.includes(`Codex bridge listening at http://127.0.0.1:${port}`)) {
      return true
    }

    try {
      const response = await boundedFetch(`http://127.0.0.1:${port}/health`, {}, 1_000)
      return response.ok
    } catch {
      return false
    }
  }, 15_000)

  return {
    child,
    baseUrl: `http://127.0.0.1:${port}`
  }
}

async function createSession(
  baseUrl: string,
  payload: Record<string, unknown>,
  timeoutMs = fetchTimeoutMs
) {
  return boundedFetch(
    `${baseUrl}/sessions`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    },
    timeoutMs
  )
}

async function postSessionAction(
  baseUrl: string,
  sessionId: string,
  action: string,
  payload: Record<string, unknown> = {},
  timeoutMs = fetchTimeoutMs
) {
  return boundedFetch(
    `${baseUrl}/sessions/${encodeURIComponent(sessionId)}/${action}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload)
    },
    timeoutMs
  )
}

async function readSessionSnapshot(response: Response) {
  assert.ok(
    response.status === 200 || response.status === 201,
    `expected session creation to return 200/201, got ${response.status}`
  )
  return response.json() as Promise<SessionSnapshot>
}

async function readErrorResponse(response: Response) {
  assert.ok(
    response.status >= 400,
    `expected error response status >= 400, got ${response.status}`
  )
  return response.json() as Promise<{ error?: string }>
}

function formatStatuses(statuses: number[]) {
  return statuses.join(", ")
}

test(
  "Codex bridge should reuse one session for concurrent same-key /sessions requests",
  { concurrency: false, timeout: testTimeoutMs },
  async (t) => {
    const fixture = await createSessionFixture(t)
    const { baseUrl } = await startBridge(t, fixture, {
      FIXTURE_THREAD_START_DELAY_MS: "250"
    })
    const stableThreadId = "thread-session-stable-key"

    const responses = await Promise.all(
      Array.from({ length: 25 }, () =>
        createSession(baseUrl, { threadId: stableThreadId })
      )
    )
    const statuses = responses.map((response) => response.status)
    const bodies = await Promise.all(responses.map((response) => readSessionSnapshot(response)))
    await delay(200)

    const spawnRecords = await fixture.syncSpawnRecords()
    const distinctSessionIds = new Set(bodies.map((body) => body.id))
    const createdCount = statuses.filter((status) => status === 201).length
    const reusedCount = statuses.filter((status) => status === 200).length
    const failures: string[] = []

    if (!statuses.every((status) => status === 200 || status === 201)) {
      failures.push(
        `expected every same-key /sessions response to be 200/201, got [${formatStatuses(statuses)}]`
      )
    }

    if (createdCount !== 1) {
      failures.push(
        `expected exactly 1 creator 201 response for same-key /sessions, got ${createdCount} from [${formatStatuses(statuses)}]`
      )
    }

    if (reusedCount !== 24) {
      failures.push(
        `expected exactly 24 reuse/join 200 responses for same-key /sessions, got ${reusedCount} from [${formatStatuses(statuses)}]`
      )
    }

    for (const body of bodies) {
      if (body.threadId !== stableThreadId) {
        failures.push(
          `expected same-key /sessions response threadId to stay ${stableThreadId}, got ${body.threadId}`
        )
        break
      }
    }

    if (distinctSessionIds.size !== 1) {
      failures.push(
        `expected one distinct session id for 25 concurrent same-key /sessions requests, got ${distinctSessionIds.size}`
      )
    }

    if (spawnRecords.length !== 1) {
      failures.push(
        `expected one app-server spawn for 25 concurrent same-key /sessions requests, got ${spawnRecords.length}`
      )
    }

    for (const record of spawnRecords) {
      if (!isProcessRunning(record.pid)) {
        failures.push(`fixture app-server pid ${record.pid} should still be alive during measurement`)
        break
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"))
  }
)

test(
  "Codex bridge should delete terminal sessions cleanly and reject follow-up turn or resume requests",
  { concurrency: false, timeout: testTimeoutMs },
  async (t) => {
    const fixture = await createSessionFixture(t)
    const { baseUrl } = await startBridge(t, fixture)

    const createResponse = await createSession(baseUrl, { threadId: "thread-delete-cleanup" })
    const session = await readSessionSnapshot(createResponse)
    const spawnRecords = await fixture.syncSpawnRecords()

    assert.equal(spawnRecords.length, 1, `expected one fixture app-server spawn, got ${spawnRecords.length}`)
    const fixturePid = spawnRecords[0]?.pid ?? -1
    assert.ok(fixturePid > 0, "expected a fixture app-server pid")
    assert.equal(isProcessRunning(fixturePid), true, `fixture app-server pid ${fixturePid} should be alive before delete`)

    const deleteResponse = await postSessionAction(baseUrl, session.id, "delete")
    const deleteBody = await readSessionSnapshot(deleteResponse)

    assert.equal(deleteResponse.status, 200, `expected delete to return 200, got ${deleteResponse.status}`)
    assert.equal(deleteBody.status, "deleted", `expected deleted session status, got ${deleteBody.status}`)
    await waitForPidExit(fixturePid)
    assert.equal(isProcessRunning(fixturePid), false, `fixture app-server pid ${fixturePid} should be gone after delete`)

    const turnResponse = await postSessionAction(baseUrl, session.id, "turns", {
      content: "Should fail after delete."
    })
    const turnBody = await readErrorResponse(turnResponse)
    assert.equal(turnResponse.status, 404, `expected deleted session turns to return 404, got ${turnResponse.status}`)
    assert.equal(turnBody.error, "Codex session not found")

    const resumeResponse = await postSessionAction(baseUrl, session.id, "resume")
    const resumeBody = await readErrorResponse(resumeResponse)
    assert.equal(resumeResponse.status, 404, `expected deleted session resume to return 404, got ${resumeResponse.status}`)
    assert.equal(resumeBody.error, "Codex session not found")
  }
)

test(
  "Codex bridge should unroute sessions after child exit and reject follow-up turn or resume requests",
  { concurrency: false, timeout: testTimeoutMs },
  async (t) => {
    const fixture = await createSessionFixture(t)
    const { baseUrl } = await startBridge(t, fixture)

    const createResponse = await createSession(baseUrl, { threadId: "thread-child-close-cleanup" })
    const session = await readSessionSnapshot(createResponse)
    const spawnRecords = await fixture.syncSpawnRecords()

    assert.equal(spawnRecords.length, 1, `expected one fixture app-server spawn, got ${spawnRecords.length}`)
    const fixturePid = spawnRecords[0]?.pid ?? -1
    assert.ok(fixturePid > 0, "expected a fixture app-server pid")

    await terminatePid(fixturePid)
    await waitForPidExit(fixturePid)
    assert.equal(isProcessRunning(fixturePid), false, `fixture app-server pid ${fixturePid} should be gone after forced exit`)

    await waitFor(async () => {
      const response = await postSessionAction(baseUrl, session.id, "resume")
      return response.status === 404
    }, 5_000, 50)

    const turnResponse = await postSessionAction(baseUrl, session.id, "turns", {
      content: "Should fail after child exit."
    })
    const turnBody = await readErrorResponse(turnResponse)
    assert.equal(turnResponse.status, 404, `expected closed session turns to return 404, got ${turnResponse.status}`)
    assert.equal(turnBody.error, "Codex session not found")

    const resumeResponse = await postSessionAction(baseUrl, session.id, "resume")
    const resumeBody = await readErrorResponse(resumeResponse)
    assert.equal(resumeResponse.status, 404, `expected closed session resume to return 404, got ${resumeResponse.status}`)
    assert.equal(resumeBody.error, "Codex session not found")
  }
)

test(
  "Codex bridge should cap no-key /sessions creation and return 429 after the limit",
  { concurrency: false, timeout: testTimeoutMs },
  async (t) => {
    const fixture = await createSessionFixture(t)
    const { baseUrl } = await startBridge(t, fixture, {
      CODEX_BRIDGE_MAX_SESSIONS: "2"
    })

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => createSession(baseUrl, {}))
    )
    const statuses = responses.map((response) => response.status)
    const acceptedResponses = responses.filter(
      (response) => response.status === 200 || response.status === 201
    )
    const acceptedBodies = await Promise.all(
      acceptedResponses.map((response) => readSessionSnapshot(response))
    )
    await delay(200)

    const spawnRecords = await fixture.syncSpawnRecords()
    const rejectedCount = statuses.filter((status) => status === 429).length
    const failures: string[] = []

    if (acceptedResponses.length > 2) {
      failures.push(
        `expected at most 2 accepted /sessions responses without a stable key, got ${acceptedResponses.length}`
      )
    }

    if (rejectedCount !== 3) {
      failures.push(
        `expected 3 rejected /sessions responses with 429 after the 2-session cap, got ${rejectedCount} from [${formatStatuses(statuses)}]`
      )
    }

    if (spawnRecords.length > 2) {
      failures.push(
        `expected at most 2 app-server spawns when CODEX_BRIDGE_MAX_SESSIONS=2, got ${spawnRecords.length}`
      )
    }

    for (const record of spawnRecords) {
      if (!isProcessRunning(record.pid)) {
        failures.push(`fixture app-server pid ${record.pid} should still be alive during measurement`)
        break
      }
    }

    for (const body of acceptedBodies) {
      if (!body.id) {
        failures.push("expected each accepted session response to include a session id")
        break
      }
    }

    assert.deepEqual(failures, [], failures.join("\n"))
  }
)
