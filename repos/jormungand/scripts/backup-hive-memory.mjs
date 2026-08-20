import { copyFile, mkdir, readFile, readdir, unlink } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import Database from "better-sqlite3"
import {
  getConfiguredDataDir,
  getHiveDatabasePath,
  getWorkflowStatePath
} from "../lib/data-paths.mjs"

const dataDir = getConfiguredDataDir(process.env)
const sourcePath = getHiveDatabasePath(process.env)
const sourceStatePath = getWorkflowStatePath(process.env)
const backupDir = resolve(dataDir, "backups")
const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15)
const backupPath = resolve(backupDir, `hive-memory-${stamp}.sqlite`)
const backupStatePath = resolve(backupDir, `hive-memory-${stamp}.state.json`)

await mkdir(backupDir, { recursive: true })
assertBackupTarget(backupPath)

const sourceStateRaw = await readFile(sourceStatePath, "utf8")
JSON.parse(sourceStateRaw)

const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
try {
  await source.backup(backupPath)
} finally {
  source.close()
}

try {
  const backup = new Database(backupPath, { fileMustExist: true })
  try {
    backup.pragma("journal_mode = DELETE")
    const integrity = String(backup.pragma("integrity_check", { simple: true }))
    if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${integrity}`)
  } finally {
    backup.close()
  }

  assertBackupTarget(backupStatePath)
  await copyFile(sourceStatePath, backupStatePath)
  JSON.parse(await readFile(backupStatePath, "utf8"))
} catch (error) {
  await removeBackupArtifacts(backupPath, backupStatePath)
  throw error
}

const backups = (await readdir(backupDir))
  .filter((name) => /^hive-memory-\d{8}-\d{6}\.sqlite$/.test(name))
  .sort()
for (const name of backups.slice(0, Math.max(0, backups.length - 14))) {
  const expiredPath = resolve(backupDir, name)
  const expiredStatePath = expiredPath.replace(/\.sqlite$/, ".state.json")
  assertBackupTarget(expiredPath)
  assertBackupTarget(expiredStatePath)
  await unlink(expiredPath)
  await unlink(`${expiredPath}-shm`).catch(() => undefined)
  await unlink(`${expiredPath}-wal`).catch(() => undefined)
  await unlink(expiredStatePath).catch(() => undefined)
}

console.log(`backup=${backupPath}`)
console.log(`workflow_state_backup=${backupStatePath}`)
console.log("integrity_check=ok")

function assertBackupTarget(target) {
  if (dirname(target) !== backupDir || relative(backupDir, target).startsWith("..") || basename(target) !== relative(backupDir, target)) {
    throw new Error(`Refusing backup operation outside ${backupDir}`)
  }
}

async function removeBackupArtifacts(sqlitePath, statePath) {
  await unlink(sqlitePath).catch(() => undefined)
  await unlink(`${sqlitePath}-shm`).catch(() => undefined)
  await unlink(`${sqlitePath}-wal`).catch(() => undefined)
  await unlink(statePath).catch(() => undefined)
}
