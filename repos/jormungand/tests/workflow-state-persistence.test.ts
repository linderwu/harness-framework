import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
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
})
