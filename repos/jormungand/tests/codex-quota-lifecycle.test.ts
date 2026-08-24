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
  grandchildPath: string
  recordsDir: string
  setMode: (mode: FixtureMode) => Promise<void>
  waitForRateLimitArrivals: (expectedCount: number) => Promise<void>
  releaseRateLimits: () => Promise<void>
  registerPid: (pid: number | null | undefined) => void
  syncSpawnRecords: () => Promise<SpawnRecord[]>
}

interface SpawnRecord {
  pid: number
  ppid: number
  grandchildPid: number
  argv: string[]
}

type FixtureMode = "success" | "error" | "hang"

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function boundedFetch(url: string, timeoutMs = fetchTimeoutMs) {
  return fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
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

async function createQuotaFixture(t: TestContext): Promise<FixtureHandle> {
  const fixtureDir = await mkdtemp(join(tmpdir(), "jormungand-codex-quota-"))
  const recordsDir = join(fixtureDir, "records")
  const grandchildPath = join(fixtureDir, "quota-grandchild.mjs")
  const fixturePath = join(fixtureDir, "codex-fixture.mjs")
  const commandPath = join(fixtureDir, "codex.cmd")
  const modePath = join(fixtureDir, "mode.txt")
  const rateLimitArrivalsDir = join(fixtureDir, "rate-limit-arrivals")
  const rateLimitReleasePath = join(fixtureDir, "release-rate-limits")
  const ownedPids = new Set<number>()

  console.log(`FIXTURE_ROOT ${fixtureDir}`)

  await Promise.all([
    mkdir(recordsDir, { recursive: true }),
    mkdir(rateLimitArrivalsDir, { recursive: true }),
    writeFile(modePath, "success", "utf8")
  ])

  const syncSpawnRecords = async () => {
    const records = await readSpawnRecords(recordsDir)

    for (const record of records) {
      registerPid(ownedPids, record.pid)
      registerPid(ownedPids, record.grandchildPid)
    }

    return records
  }

  t.after(async () => {
    await syncSpawnRecords()
    await cleanupOwnedPids(ownedPids)
    await removeOwnedFixtureRoot(fixtureDir)
  })

  await writeFile(
    grandchildPath,
    [
      'const hold = setInterval(() => {}, 30_000)',
      "const stop = () => {",
      "  clearInterval(hold)",
      "  process.exit(0)",
      "}",
      'process.on("SIGTERM", stop)',
      'process.on("SIGINT", stop)'
    ].join("\n"),
    "utf8"
  )

  await writeFile(
    fixturePath,
    [
      'import { spawn } from "node:child_process"',
      'import { existsSync, mkdirSync, writeFileSync } from "node:fs"',
      'import { readFileSync } from "node:fs"',
      'import { join } from "node:path"',
      "",
      "const recordsDir = process.env.FIXTURE_RECORDS_DIR",
      "const grandchildScript = process.env.FIXTURE_GRANDCHILD_PATH",
      "const modePath = process.env.FIXTURE_MODE_PATH",
      "const rateLimitArrivalsDir = process.env.FIXTURE_RATE_LIMIT_ARRIVALS_DIR",
      "const rateLimitReleasePath = process.env.FIXTURE_RATE_LIMIT_RELEASE_PATH",
      "if (!recordsDir || !grandchildScript || !modePath || !rateLimitArrivalsDir || !rateLimitReleasePath) {",
      '  throw new Error("Missing fixture record paths.")',
      "}",
      "",
      "mkdirSync(recordsDir, { recursive: true })",
      "const grandchild = spawn(process.execPath, [grandchildScript], {",
      '  stdio: "ignore"',
      "})",
      "const record = {",
      "  pid: process.pid,",
      "  ppid: process.ppid,",
      "  grandchildPid: grandchild.pid ?? -1,",
      "  argv: process.argv.slice(2)",
      "}",
      'writeFileSync(join(recordsDir, `${process.pid}.json`), JSON.stringify(record, null, 2), "utf8")',
      "",
      "const hold = setInterval(() => {}, 30_000)",
      "const stop = () => {",
      "  clearInterval(hold)",
      "  try {",
      "    if (grandchild.pid) process.kill(grandchild.pid)",
      "  } catch {}",
      "  process.exit(0)",
      "}",
      'process.on("SIGTERM", stop)',
      'process.on("SIGINT", stop)',
      "",
      "let buffer = \"\"",
      'process.stdin.setEncoding("utf8")',
      'const writeMessage = (message) => process.stdout.write(`${JSON.stringify(message)}\\n`)',
      "const readMode = () => {",
      "  try {",
      '    const mode = readFileSync(modePath, "utf8").trim()',
      '    return mode || "success"',
      "  } catch {",
      '    return "success"',
      "  }",
      "}",
      "const waitForRateLimitRelease = async () => {",
      "  while (!existsSync(rateLimitReleasePath)) {",
      "    await new Promise((resolve) => setTimeout(resolve, 10))",
      "  }",
      "}",
      'process.stdin.on("data", async (chunk) => {',
      "  buffer += chunk",
      "  const lines = buffer.split(/\\r?\\n/)",
      "  buffer = lines.pop() ?? \"\"",
      "  for (const line of lines) {",
      "    if (!line.trim()) continue",
      "    const message = JSON.parse(line)",
      '    if (message.method === "initialized") continue',
      "    if (message.id === undefined) continue",
      '    if (message.method === "initialize") {',
      '      writeMessage({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "quota-fixture", version: "0.1.0" } } })',
      "      continue",
      "    }",
      '    if (message.method === "account/read") {',
      '      writeMessage({ jsonrpc: "2.0", id: message.id, result: { account: { email: "fixture@example.com" } } })',
      "      continue",
      "    }",
      '    if (message.method === "account/rateLimits/read") {',
      '      writeFileSync(join(rateLimitArrivalsDir, `${process.pid}.arrival`), "", "utf8")',
      "      const mode = readMode()",
      '      if (mode === "error") {',
      '        writeMessage({ jsonrpc: "2.0", id: message.id, error: { message: "Fixture rate limit failure." } })',
      "        continue",
      "      }",
      '      if (mode === "hang") {',
      "        continue",
      "      }",
      "      await waitForRateLimitRelease()",
      '      writeMessage({ jsonrpc: "2.0", id: message.id, result: { rateLimits: { primary: { usedPercent: 12, resetsAt: 1_900_000_000 } } } })',
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
    grandchildPath,
    recordsDir,
    setMode: (mode) => writeFile(modePath, mode, "utf8"),
    waitForRateLimitArrivals: (expectedCount) =>
      waitFor(async () => {
        const entries = await readdir(rateLimitArrivalsDir)
        return entries.filter((entry) => entry.endsWith(".arrival")).length >= expectedCount
      }, 5_000, 20),
    releaseRateLimits: () => writeFile(rateLimitReleasePath, "release", "utf8"),
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
      FIXTURE_GRANDCHILD_PATH: fixture.grandchildPath,
      FIXTURE_RECORDS_DIR: fixture.recordsDir,
      FIXTURE_MODE_PATH: join(fixture.fixtureDir, "mode.txt"),
      FIXTURE_RATE_LIMIT_ARRIVALS_DIR: join(fixture.fixtureDir, "rate-limit-arrivals"),
      FIXTURE_RATE_LIMIT_RELEASE_PATH: join(fixture.fixtureDir, "release-rate-limits"),
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
      const response = await boundedFetch(`http://127.0.0.1:${port}/health`, 1_000)
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

async function readQuotaJson(response: Response) {
  assert.equal(response.status, 200)
  return response.json() as Promise<{
    agentId: string
    remainingPercent: number
    updatedAt: string
  }>
}

async function readQuotaError(response: Response) {
  assert.equal(response.status, 500)
  return response.json() as Promise<{ error: string }>
}

test(
  "Codex bridge should cache and single-flight quota polls",
  { concurrency: false, timeout: testTimeoutMs },
  async (t) => {
    const fixture = await createQuotaFixture(t)
    const { baseUrl } = await startBridge(t, fixture, {
      CODEX_BRIDGE_QUOTA_CACHE_TTL_MS: "120"
    })

    const responsePromises = Array.from({ length: 25 }, () =>
      boundedFetch(`${baseUrl}/agent-quota`)
    )
    const responsesPromise = Promise.all(responsePromises)
    void responsesPromise.catch(() => {})
    await fixture.waitForRateLimitArrivals(1)
    await fixture.releaseRateLimits()
    const responses = await responsesPromise

    await waitFor(async () => (await fixture.syncSpawnRecords()).length >= 1)
    const spawnRecords = await fixture.syncSpawnRecords()
    assert.equal(
      spawnRecords.length,
      1,
      `expected one app-server spawn for 25 concurrent quota requests, got ${spawnRecords.length}`
    )

    const bodies = await Promise.all(responses.map((response) => readQuotaJson(response)))
    const firstBody = JSON.stringify(bodies[0])
    for (const body of bodies) {
      assert.equal(body.agentId, "codex")
      assert.equal(body.remainingPercent, 88)
      assert.equal(JSON.stringify(body), firstBody)
    }

    const cachedBodyOne = await readQuotaJson(await boundedFetch(`${baseUrl}/agent-quota`))
    const cachedBodyTwo = await readQuotaJson(await boundedFetch(`${baseUrl}/agent-quota`))
    assert.equal(JSON.stringify(cachedBodyOne), firstBody)
    assert.equal(JSON.stringify(cachedBodyTwo), firstBody)
    assert.equal((await fixture.syncSpawnRecords()).length, 1)

    await delay(180)
    const refreshedBody = await readQuotaJson(await boundedFetch(`${baseUrl}/agent-quota`))
    assert.equal(refreshedBody.agentId, "codex")
    assert.equal(refreshedBody.remainingPercent, 88)
    assert.notEqual(refreshedBody.updatedAt, bodies[0].updatedAt)
    await waitFor(async () => (await fixture.syncSpawnRecords()).length >= 2)
    assert.equal((await fixture.syncSpawnRecords()).length, 2)
  }
)

test(
  "Codex bridge should short-cache quota failures without respawning",
  { concurrency: false, timeout: testTimeoutMs },
  async (t) => {
    const fixture = await createQuotaFixture(t)
    await fixture.setMode("error")
    const { baseUrl } = await startBridge(t, fixture, {
      CODEX_BRIDGE_QUOTA_FAILURE_TTL_MS: "120"
    })

    const burstResponses = await Promise.all(
      Array.from({ length: 10 }, () => boundedFetch(`${baseUrl}/agent-quota`))
    )
    const burstBodies = await Promise.all(
      burstResponses.map((response) => readQuotaError(response))
    )
    for (const body of burstBodies) {
      assert.match(body.error, /Fixture rate limit failure\./)
    }

    await waitFor(async () => (await fixture.syncSpawnRecords()).length >= 1)
    assert.equal((await fixture.syncSpawnRecords()).length, 1)

    const cachedFailure = await readQuotaError(await boundedFetch(`${baseUrl}/agent-quota`))
    assert.match(cachedFailure.error, /Fixture rate limit failure\./)
    assert.equal((await fixture.syncSpawnRecords()).length, 1)

    await delay(180)
    await fixture.setMode("success")
    await fixture.releaseRateLimits()
    const recoveryBody = await readQuotaJson(await boundedFetch(`${baseUrl}/agent-quota`))
    assert.equal(recoveryBody.remainingPercent, 88)
    await waitFor(async () => (await fixture.syncSpawnRecords()).length >= 2)
    assert.equal((await fixture.syncSpawnRecords()).length, 2)
  }
)

test(
  "Codex bridge should time out hung quota reads and clean descendants",
  { concurrency: false, timeout: testTimeoutMs },
  async (t) => {
    const fixture = await createQuotaFixture(t)
    await fixture.setMode("hang")
    const { baseUrl } = await startBridge(t, fixture, {
      CODEX_BRIDGE_QUOTA_FAILURE_TTL_MS: "80",
      CODEX_BRIDGE_QUOTA_TIMEOUT_MS: "500"
    })

    const startedAt = Date.now()
    const hungResponsePromise = boundedFetch(`${baseUrl}/agent-quota`, 3_000)
    void hungResponsePromise.catch(() => {})
    await fixture.waitForRateLimitArrivals(1)
    const hungResponse = await hungResponsePromise
    const elapsedMs = Date.now() - startedAt
    assert.ok(elapsedMs < 2_000, `expected timeout response to be bounded, got ${elapsedMs}ms`)
    const hungBody = await readQuotaError(hungResponse)
    assert.match(hungBody.error, /timed out after 500ms/i)

    await waitFor(async () => (await fixture.syncSpawnRecords()).length >= 1)
    const [record] = await fixture.syncSpawnRecords()
    assert.ok(record)
    assert.ok(record.grandchildPid > 0)

    const fixtureProcessExited = await waitFor(
      async () => !isProcessRunning(record.pid),
      1_500,
      25
    ).then(
      () => true,
      () => false
    )
    assert.equal(fixtureProcessExited, true, `fixture process ${record.pid} should be gone after timeout cleanup`)

    const grandchildExited = await waitFor(
      async () => !isProcessRunning(record.grandchildPid),
      1_500,
      25
    ).then(
      () => true,
      () => false
    )
    assert.equal(
      grandchildExited,
      true,
      `fixture grandchild ${record.grandchildPid} should be gone after timeout cleanup`
    )

    if (process.platform === "win32") {
      const wrapperExited = await waitFor(
        async () => !isProcessRunning(record.ppid),
        1_500,
        25
      ).then(
        () => true,
        () => false
      )
      assert.equal(
        wrapperExited,
        true,
        `fixture wrapper ${record.ppid} should be gone after timeout cleanup`
      )
    }

    await delay(120)
    await fixture.setMode("success")
    await fixture.releaseRateLimits()
    const recoveryBody = await readQuotaJson(await boundedFetch(`${baseUrl}/agent-quota`))
    assert.equal(recoveryBody.remainingPercent, 88)
    await waitFor(async () => (await fixture.syncSpawnRecords()).length >= 2)
    assert.equal((await fixture.syncSpawnRecords()).length, 2)
  }
)

test(
  "Codex bridge should tear down Windows quota wrapper descendants after quota completion",
  {
    concurrency: false,
    timeout: testTimeoutMs,
    skip:
      process.platform === "win32"
        ? false
        : "Windows-only regression for cmd.exe wrapper descendants"
  },
  async (t) => {
    const fixture = await createQuotaFixture(t)
    const { baseUrl } = await startBridge(t, fixture)

    const responsePromise = boundedFetch(`${baseUrl}/agent-quota`)
    void responsePromise.catch(() => {})
    await fixture.waitForRateLimitArrivals(1)
    await fixture.releaseRateLimits()
    const response = await responsePromise
    assert.equal(response.status, 200)

    await waitFor(async () => (await fixture.syncSpawnRecords()).length >= 1)
    const spawnRecords = await fixture.syncSpawnRecords()
    assert.equal(spawnRecords.length, 1)
    const [record] = spawnRecords
    assert.ok(record.grandchildPid > 0)

    const fixtureProcessExited = await waitFor(
      async () => !isProcessRunning(record.pid),
      1_500,
      25
    ).then(
      () => true,
      () => false
    )
    assert.equal(
      fixtureProcessExited,
      true,
      `fixture process ${record.pid} should be gone shortly after /agent-quota completes`
    )

    const grandchildExited = await waitFor(
      async () => !isProcessRunning(record.grandchildPid),
      1_500,
      25
    ).then(
      () => true,
      () => false
    )

    assert.equal(
      grandchildExited,
      true,
      `fixture grandchild ${record.grandchildPid} should be gone shortly after /agent-quota completes`
    )

    const wrapperExited = await waitFor(
      async () => !isProcessRunning(record.ppid),
      1_500,
      25
    ).then(
      () => true,
      () => false
    )
    assert.equal(
      wrapperExited,
      true,
      `fixture wrapper ${record.ppid} should be gone shortly after /agent-quota completes`
    )
  }
)
