import { mkdir, readdir, unlink } from "node:fs/promises"
import { basename, dirname, relative, resolve } from "node:path"
import Database from "better-sqlite3"

const dataDir = resolve(process.env.JORMUNGAND_DATA_DIR?.trim() || resolve(process.cwd(), "data"))
const sourcePath = resolve(dataDir, "hive-memory.sqlite")
const backupDir = resolve(dataDir, "backups")
const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").replace("T", "-").slice(0, 15)
const backupPath = resolve(backupDir, `hive-memory-${stamp}.sqlite`)

await mkdir(backupDir, { recursive: true })
assertBackupTarget(backupPath)
const source = new Database(sourcePath, { readonly: true, fileMustExist: true })
try {
  await source.backup(backupPath)
} finally {
  source.close()
}

const backup = new Database(backupPath, { fileMustExist: true })
backup.pragma("journal_mode = DELETE")
const integrity = String(backup.pragma("integrity_check", { simple: true }))
backup.close()
if (integrity !== "ok") throw new Error(`Backup integrity check failed: ${integrity}`)

const backups = (await readdir(backupDir))
  .filter((name) => /^hive-memory-\d{8}-\d{6}\.sqlite$/.test(name))
  .sort()
for (const name of backups.slice(0, Math.max(0, backups.length - 14))) {
  const expiredPath = resolve(backupDir, name)
  assertBackupTarget(expiredPath)
  await unlink(expiredPath)
  await unlink(`${expiredPath}-shm`).catch(() => undefined)
  await unlink(`${expiredPath}-wal`).catch(() => undefined)
}

console.log(`backup=${backupPath}`)
console.log("integrity_check=ok")

function assertBackupTarget(target) {
  if (dirname(target) !== backupDir || relative(backupDir, target).startsWith("..") || basename(target) !== relative(backupDir, target)) {
    throw new Error(`Refusing backup operation outside ${backupDir}`)
  }
}
