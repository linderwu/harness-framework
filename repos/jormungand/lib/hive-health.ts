import { readdir, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import type { HiveDatabase } from "./hive-memory/database"
import { getHiveDataDir } from "./hive-memory/database"

export interface HiveMemoryHealthSummary {
  status: "ready" | "read_only" | "unavailable"
  schemaVersion: number
  databasePath: string
  pathWithinConfiguredDataDir: boolean
  integrity: "ok" | "unavailable"
  lastBackupAt?: string
}

export async function getHiveMemoryHealth(database: HiveDatabase): Promise<HiveMemoryHealthSummary> {
  const health = database.health()
  const dataDir = resolve(getHiveDataDir())
  const databasePath = resolve(health.path)
  const pathFromDataDir = relative(dataDir, databasePath)
  const pathWithinConfiguredDataDir = pathFromDataDir !== "" && !pathFromDataDir.startsWith("..") && !isAbsolute(pathFromDataDir)
  let integrity: HiveMemoryHealthSummary["integrity"] = "unavailable"
  let schemaVersion = 0
  if (health.status === "ready") {
    integrity = database.pragma("integrity_check") === "ok" ? "ok" : "unavailable"
    schemaVersion = database.schemaVersion()
  }
  return {
    status: health.status,
    schemaVersion,
    databasePath,
    pathWithinConfiguredDataDir,
    integrity,
    lastBackupAt: await latestBackupTime(resolve(dataDir, "backups"))
  }
}

async function latestBackupTime(backupDir: string) {
  const names = await readdir(backupDir).catch(() => [])
  const candidates = await Promise.all(names
    .filter((name) => /^hive-memory-\d{8}-\d{6}\.sqlite$/.test(name))
    .map(async (name) => stat(resolve(backupDir, name)).then((item) => item.mtime.toISOString()).catch(() => undefined)))
  return candidates.filter((value): value is string => Boolean(value)).sort().at(-1)
}
