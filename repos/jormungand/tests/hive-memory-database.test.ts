import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { openHiveDatabase } from "../lib/hive-memory/database"

test("database initializes WAL schema and survives restart", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-memory-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const first = openHiveDatabase({ dataDir })
  assert.equal(first.health().status, "ready")
  assert.equal(first.pragma("journal_mode"), "wal")
  assert.equal(first.schemaVersion(), 6)
  first.close()

  const second = openHiveDatabase({ dataDir })
  assert.equal(second.health().status, "ready")
  assert.equal(second.schemaVersion(), 6)
  second.close()
})

test("database opening with an explicit data directory does not mutate process-global env", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-memory-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const previousDataDir = process.env.JORMUNGAND_DATA_DIR
  const database = openHiveDatabase({
    dataDir,
    env: { JORMUNGAND_DATA_DIR: "keep-existing-env" }
  })
  assert.equal(database.health().status, "ready")
  assert.equal(process.env.JORMUNGAND_DATA_DIR, previousDataDir)
  database.close()
})

test("database without an explicit directory uses the configured env root", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-memory-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))

  const database = openHiveDatabase({ env: { JORMUNGAND_DATA_DIR: dataDir } })
  assert.equal(database.health().status, "ready")
  assert.equal(database.health().path, join(dataDir, "hive-memory.sqlite"))
  database.close()
})

test("database serializes writes", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-memory-"))
  const database = openHiveDatabase({ dataDir })
  t.after(async () => {
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  await Promise.all([
    database.write((connection) => {
      connection.prepare("INSERT INTO hive_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "event-1", "test", "control_plane", null, null, "{}", "write-1", new Date().toISOString()
      )
    }),
    database.write((connection) => {
      connection.prepare("INSERT INTO hive_events VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        "event-2", "test", "control_plane", null, null, "{}", "write-2", new Date().toISOString()
      )
    })
  ])

  const count = database.read((connection) =>
    connection.prepare("SELECT COUNT(*) AS count FROM hive_events").get() as { count: number }
  )
  assert.equal(count.count, 2)
})

test("corrupt database fails closed", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-memory-"))
  t.after(() => rm(dataDir, { recursive: true, force: true }))
  await writeFile(join(dataDir, "hive-memory.sqlite"), "not sqlite")

  const database = openHiveDatabase({ dataDir })
  assert.equal(database.health().status, "unavailable")
  await assert.rejects(database.write(() => undefined), /memory unavailable/i)
  database.close()
})
