import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn } from "node:child_process"

const [serverName, targetScript, ...targetArgs] = process.argv.slice(2)

if (!serverName || !targetScript) {
  console.error("Usage: node mcp-single-instance-launcher.mjs <name> <script> [args...]")
  process.exit(64)
}

const parentPid = process.ppid
const lockDirectory = path.join(os.tmpdir(), "codex-mcp-singletons")
const safeName = serverName.replace(/[^a-zA-Z0-9_.-]/g, "_")
const lockPath = path.join(lockDirectory, `${parentPid}-${safeName}.lock`)
let lockHandle
let child
let parentWatch
let shutdownPromise

async function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readLockOwner() {
  try {
    return JSON.parse(await fs.readFile(lockPath, "utf8"))
  } catch {
    return undefined
  }
}

async function acquireLock() {
  await fs.mkdir(lockDirectory, { recursive: true })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      lockHandle = await fs.open(lockPath, "wx")
      await lockHandle.writeFile(
        JSON.stringify({
          pid: process.pid,
          parentPid,
          serverName,
          startedAt: new Date().toISOString()
        })
      )
      return
    } catch (error) {
      if (error?.code !== "EEXIST") throw error
      const owner = await readLockOwner()
      if (owner?.parentPid === parentPid && await isProcessAlive(owner.pid)) {
        throw new Error(`MCP instance already active for ${serverName} and app-server ${parentPid}`)
      }
      await fs.rm(lockPath, { force: true })
    }
  }

  throw new Error(`Unable to acquire MCP singleton lock for ${serverName}`)
}

async function terminateChild() {
  if (!child || child.exitCode !== null) return

  if (process.platform === "win32" && child.pid) {
    await new Promise((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true }
      )
      killer.once("error", resolve)
      killer.once("close", resolve)
    })
    return
  }

  child.kill("SIGTERM")
}

async function releaseLock() {
  if (lockHandle) {
    await lockHandle.close().catch(() => {})
    lockHandle = undefined
  }
  await fs.rm(lockPath, { force: true }).catch(() => {})
}

async function shutdown(exitCode) {
  if (shutdownPromise) return shutdownPromise

  shutdownPromise = (async () => {
    if (parentWatch) clearInterval(parentWatch)
    await terminateChild()
    await releaseLock()
    process.exitCode = exitCode
  })()

  return shutdownPromise
}

try {
  await acquireLock()

  child = spawn(process.execPath, [targetScript, ...targetArgs], {
    stdio: "inherit",
    windowsHide: true
  })

  parentWatch = setInterval(async () => {
    if (!await isProcessAlive(parentPid)) await shutdown(0)
  }, 2_000)
  parentWatch.unref()

  child.once("error", async (error) => {
    console.error(`MCP ${serverName} child failed: ${error.message}`)
    await shutdown(1)
  })
  child.once("close", async (code) => {
    await releaseLock()
    process.exitCode = code ?? 1
  })

  process.once("SIGINT", () => void shutdown(130))
  process.once("SIGTERM", () => void shutdown(143))
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  await releaseLock()
  process.exit(1)
}
