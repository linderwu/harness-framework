import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createHiveServices } from "../lib/hive-services"
import { openHiveDatabase } from "../lib/hive-memory/database"
import { createHiveMemoryRepository } from "../lib/hive-memory/repository"

test("createHiveServices exposes a stopped Codex sync worker for isolated tests", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "jormungand-codex-service-"))
  const database = openHiveDatabase({ dataDir })
  const repository = createHiveMemoryRepository(database)
  const services = createHiveServices({
    database,
    repository,
    startCodexSyncWorker: false
  })
  t.after(async () => {
    services.codexSyncWorker.stop()
    database.close()
    await rm(dataDir, { recursive: true, force: true })
  })

  assert.equal(typeof services.codexSyncWorker.tick, "function")
  assert.equal(typeof services.codexSyncWorker.stop, "function")
})

test("default Hive services starts one Codex sync worker", () => {
  const source = readFileSync("lib/hive-services.ts", "utf8")
  assert.match(source, /createHiveServices\(\{ startCodexSyncWorker: true \}\)/)
  assert.match(source, /codexSyncWorker\.start\(\)/)
})
