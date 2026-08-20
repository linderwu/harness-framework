import { readFile, readdir, stat } from "node:fs/promises"
import { isAbsolute, relative, resolve } from "node:path"
import { getConfiguredDataDir, getWorkflowStatePath, type DataPathEnv } from "./data-paths"
import type { HiveDatabase } from "./hive-memory/database"

export interface HiveMemoryHealthSummary {
  status: "ready" | "read_only" | "unavailable"
  schemaVersion: number
  databasePath: string
  pathWithinConfiguredDataDir: boolean
  workflowStatePath: string
  workflowStatePathWithinConfiguredDataDir: boolean
  workflowStateStatus: "ready" | "missing" | "invalid"
  integrity: "ok" | "unavailable"
  lastBackupAt?: string
}

export async function getHiveMemoryHealth(
  database: HiveDatabase,
  env: DataPathEnv = process.env
): Promise<HiveMemoryHealthSummary> {
  const health = database.health()
  const dataDir = resolve(getConfiguredDataDir(env))
  const databasePath = resolve(health.path)
  const workflowStatePath = resolve(getWorkflowStatePath(env))
  const pathFromDataDir = relative(dataDir, databasePath)
  const pathWithinConfiguredDataDir = pathFromDataDir !== "" && !pathFromDataDir.startsWith("..") && !isAbsolute(pathFromDataDir)
  const workflowStatePathFromDataDir = relative(dataDir, workflowStatePath)
  const workflowStatePathWithinConfiguredDataDir = workflowStatePathFromDataDir !== "" && !workflowStatePathFromDataDir.startsWith("..") && !isAbsolute(workflowStatePathFromDataDir)
  const workflowStateStatus = await inspectWorkflowState(workflowStatePath)
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
    workflowStatePath,
    workflowStatePathWithinConfiguredDataDir,
    workflowStateStatus,
    integrity,
    lastBackupAt: await latestBackupTime(resolve(dataDir, "backups"))
  }
}

async function inspectWorkflowState(workflowStatePath: string): Promise<HiveMemoryHealthSummary["workflowStateStatus"]> {
  try {
    const raw = await readFile(workflowStatePath, "utf8")
    JSON.parse(raw)
    return "ready"
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing"
    }

    return "invalid"
  }
}

async function latestBackupTime(backupDir: string) {
  const names = await readdir(backupDir).catch(() => [])
  const candidates = await Promise.all(names
    .filter((name) => /^hive-memory-\d{8}-\d{6}\.sqlite$/.test(name))
    .map(async (name) => stat(resolve(backupDir, name)).then((item) => item.mtime.toISOString()).catch(() => undefined)))
  return candidates.filter((value): value is string => Boolean(value)).sort().at(-1)
}
