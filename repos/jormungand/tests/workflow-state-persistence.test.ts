import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import test from "node:test"
import { getHiveMemoryHealth } from "../lib/hive-health"
import { openHiveDatabase } from "../lib/hive-memory/database"

const legacyState = {
  schemaVersion: 3,
  projects: [],
  workflowRuns: [],
  warnings: [{ code: "legacy_project_created", message: "legacy state" }]
}

const configuredState = {
  schemaVersion: 3,
  projects: [],
  workflowRuns: [],
  warnings: [{ code: "legacy_project_created", message: "configured state" }]
}

const readyState = {
  schemaVersion: 3,
  projects: [],
  workflowRuns: []
}

async function withStore<T>(
  workspaceRoot: string,
  operation: (store: typeof import("../lib/store")) => Promise<T>
) {
  const previousCwd = process.cwd()
  process.chdir(workspaceRoot)
  delete require.cache[require.resolve("../lib/store")]

  try {
    const store = (await import("../lib/store")) as typeof import("../lib/store")
    return await operation(store)
  } finally {
    process.chdir(previousCwd)
  }
}

test("legacy workflow state is copied into the configured root on first read", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "jormungand-workspace-"))
  const configuredRoot = await mkdtemp(join(tmpdir(), "jormungand-configured-"))
  const legacyStatePath = join(workspaceRoot, "data", "harness-state.json")
  const configuredStatePath = join(configuredRoot, "harness-state.json")

  await mkdir(join(workspaceRoot, "data"), { recursive: true })
  await writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2))

  const previousDataDir = process.env.JORMUNGAND_DATA_DIR
  process.env.JORMUNGAND_DATA_DIR = configuredRoot
  t.after(() => {
    if (previousDataDir === undefined) {
      delete process.env.JORMUNGAND_DATA_DIR
      return
    }

    process.env.JORMUNGAND_DATA_DIR = previousDataDir
  })

  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(configuredRoot, { recursive: true, force: true })
  })

  await withStore(workspaceRoot, async ({ readState }) => {
    const state = await readState()

    assert.equal(state.warnings?.[0]?.message, "legacy state")
    const copiedState = JSON.parse(await readFile(configuredStatePath, "utf8")) as typeof legacyState
    assert.equal(copiedState.warnings?.[0]?.message, "legacy state")
  })
})

test("newer configured workflow state is not overwritten by the legacy source", async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "jormungand-workspace-"))
  const configuredRoot = await mkdtemp(join(tmpdir(), "jormungand-configured-"))
  const legacyStatePath = join(workspaceRoot, "data", "harness-state.json")
  const configuredStatePath = join(configuredRoot, "harness-state.json")

  await mkdir(join(workspaceRoot, "data"), { recursive: true })
  await writeFile(legacyStatePath, JSON.stringify(legacyState, null, 2))
  await writeFile(configuredStatePath, JSON.stringify(configuredState, null, 2))

  const previousDataDir = process.env.JORMUNGAND_DATA_DIR
  process.env.JORMUNGAND_DATA_DIR = configuredRoot
  t.after(() => {
    if (previousDataDir === undefined) {
      delete process.env.JORMUNGAND_DATA_DIR
      return
    }

    process.env.JORMUNGAND_DATA_DIR = previousDataDir
  })

  t.after(async () => {
    await rm(workspaceRoot, { recursive: true, force: true })
    await rm(configuredRoot, { recursive: true, force: true })
  })

  await withStore(workspaceRoot, async ({ readState }) => {
    const state = await readState()

    assert.equal(state.warnings?.[0]?.message, "configured state")
    const storedConfiguredState = JSON.parse(
      await readFile(configuredStatePath, "utf8")
    ) as typeof configuredState
    assert.equal(storedConfiguredState.warnings?.[0]?.message, "configured state")
  })
})

test("health reports workflow state and hive paths inside the configured root", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-health-"))
  const database = openHiveDatabase({ dataDir })
  await writeReadyWorkflowState(dataDir, readyState)

  const previousDataDir = process.env.JORMUNGAND_DATA_DIR
  process.env.JORMUNGAND_DATA_DIR = dataDir
  t.after(() => {
    if (previousDataDir === undefined) {
      delete process.env.JORMUNGAND_DATA_DIR
      return
    }

    process.env.JORMUNGAND_DATA_DIR = previousDataDir
  })

  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const health = await getHiveMemoryHealth(database)

  assert.equal(health.databasePath, join(dataDir, "hive-memory.sqlite"))
  assert.equal(health.workflowStatePath, join(dataDir, "harness-state.json"))
  assert.equal(health.pathWithinConfiguredDataDir, true)
  assert.equal(health.workflowStateStatus, "ready")
})

test("health reports invalid workflow state without throwing", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-health-"))
  const database = openHiveDatabase({ dataDir })
  await writeFile(join(dataDir, "harness-state.json"), "{not valid json")

  const previousDataDir = process.env.JORMUNGAND_DATA_DIR
  process.env.JORMUNGAND_DATA_DIR = dataDir
  t.after(() => {
    if (previousDataDir === undefined) {
      delete process.env.JORMUNGAND_DATA_DIR
      return
    }

    process.env.JORMUNGAND_DATA_DIR = previousDataDir
  })

  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const health = await getHiveMemoryHealth(database)

  assert.equal(health.workflowStatePath, join(dataDir, "harness-state.json"))
  assert.equal(health.workflowStatePathWithinConfiguredDataDir, true)
  assert.equal(health.workflowStateStatus, "invalid")
  assert.equal(health.status, "ready")
})

test("health reports missing workflow state without throwing", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-health-"))
  const database = openHiveDatabase({ dataDir })

  const previousDataDir = process.env.JORMUNGAND_DATA_DIR
  process.env.JORMUNGAND_DATA_DIR = dataDir
  t.after(() => {
    if (previousDataDir === undefined) {
      delete process.env.JORMUNGAND_DATA_DIR
      return
    }

    process.env.JORMUNGAND_DATA_DIR = previousDataDir
  })

  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const health = await getHiveMemoryHealth(database)

  assert.equal(health.workflowStatePath, join(dataDir, "harness-state.json"))
  assert.equal(health.workflowStatePathWithinConfiguredDataDir, true)
  assert.equal(health.workflowStateStatus, "missing")
  assert.equal(health.status, "ready")
})

test("backup and verify preserve paired sqlite and workflow state artifacts", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-backup-"))
  const database = openHiveDatabase({ dataDir })
  await writeReadyWorkflowState(dataDir, readyState)

  const previousDataDir = process.env.JORMUNGAND_DATA_DIR
  process.env.JORMUNGAND_DATA_DIR = dataDir
  t.after(() => {
    if (previousDataDir === undefined) {
      delete process.env.JORMUNGAND_DATA_DIR
      return
    }

    process.env.JORMUNGAND_DATA_DIR = previousDataDir
  })

  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  const backupScript = resolve(process.cwd(), "scripts", "backup-hive-memory.mjs")
  const verifyScript = resolve(process.cwd(), "scripts", "verify-hive-memory-backup.mjs")
  const env = { ...process.env, JORMUNGAND_DATA_DIR: dataDir }

  const backupResult = spawnSync(process.execPath, [backupScript], {
    encoding: "utf8",
    env
  })

  assert.equal(backupResult.status, 0, backupResult.stderr)
  const backupPath = parseScriptOutput(backupResult.stdout, "backup")
  const workflowStateBackupPath = parseScriptOutput(backupResult.stdout, "workflow_state_backup")
  assert.equal(workflowStateBackupPath, backupPath.replace(/\.sqlite$/, ".state.json"))
  assert.equal(await readFile(workflowStateBackupPath, "utf8"), JSON.stringify(readyState, null, 2))

  const verifyResult = spawnSync(process.execPath, [verifyScript, backupPath], {
    encoding: "utf8",
    env
  })

  assert.equal(verifyResult.status, 0, verifyResult.stderr)
  assert.match(verifyResult.stdout, /restore_verification=PASS/)

  const health = await getHiveMemoryHealth(database)

  assert.equal(health.workflowStateStatus, "ready")
})

async function writeReadyWorkflowState(dataDir: string, state: typeof readyState) {
  await writeFile(join(dataDir, "harness-state.json"), JSON.stringify(state, null, 2))
}

function parseScriptOutput(stdout: string, key: string) {
  const line = stdout.split(/\r?\n/).find((item) => item.startsWith(`${key}=`))

  if (!line) {
    throw new Error(`Missing ${key} output:\n${stdout}`)
  }

  return line.slice(key.length + 1)
}
