import { cp, mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join, resolve } from "node:path"
import Database from "better-sqlite3"

const requestedPath = process.argv[2]
if (!requestedPath) throw new Error("Usage: npm run memory:verify-backup -- <backup.sqlite>")
const sourcePath = resolve(requestedPath)
const restoreDir = await mkdtemp(join(tmpdir(), "jormungand-hive-restore-"))
const restoredPath = join(restoreDir, basename(sourcePath))

try {
  await cp(sourcePath, restoredPath, { errorOnExist: true })
  const source = inspect(sourcePath)
  const restored = inspect(restoredPath)
  if (source.schemaVersion !== restored.schemaVersion) throw new Error("Restored schema version differs from backup.")
  for (const table of Object.keys(source.counts)) {
    if (source.counts[table] !== restored.counts[table]) throw new Error(`Restored row count differs for ${table}.`)
  }
  console.log(`verified=${sourcePath}`)
  console.log(`schema_version=${restored.schemaVersion}`)
  console.log("integrity_check=ok")
  console.log("restore_verification=PASS")
} finally {
  await rm(restoreDir, { recursive: true, force: true })
}

function inspect(path) {
  const database = new Database(path, { readonly: true, fileMustExist: true })
  try {
    const integrity = String(database.pragma("integrity_check", { simple: true }))
    if (integrity !== "ok") throw new Error(`Integrity check failed for ${path}: ${integrity}`)
    const schemaVersion = database.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version
    const tables = ["hive_events", "memories", "memory_candidates", "manager_checkpoints", "manager_tasks", "conversation_entries"]
    const counts = Object.fromEntries(tables.map((table) => [table, database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count]))
    return { schemaVersion, counts }
  } finally {
    database.close()
  }
}
