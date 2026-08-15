import { mkdirSync } from "node:fs"
import { resolve } from "node:path"
import Database from "better-sqlite3"
import { hiveSchemaVersion, migrateHiveSchema } from "./schema"

export type HiveDatabaseHealth =
  | { status: "ready"; path: string }
  | { status: "read_only"; path: string; reason: string }
  | { status: "unavailable"; path: string; reason: string }

export interface HiveDatabase {
  read<T>(operation: (database: Database.Database) => T): T
  write<T>(operation: (database: Database.Database) => T): Promise<T>
  transaction<T>(operation: (database: Database.Database) => T): Promise<T>
  health(): HiveDatabaseHealth
  schemaVersion(): number
  pragma(name: "journal_mode" | "integrity_check"): string
  close(): void
}

let writeQueue = Promise.resolve()

export function getHiveDataDir() {
  return resolve(process.env.JORMUNGAND_DATA_DIR?.trim() || resolve(process.cwd(), "data"))
}

export function openHiveDatabase(options: { dataDir?: string } = {}): HiveDatabase {
  const dataDir = resolve(options.dataDir ?? getHiveDataDir())
  const databasePath = resolve(dataDir, "hive-memory.sqlite")
  let connection: Database.Database | undefined
  let currentHealth: HiveDatabaseHealth

  try {
    mkdirSync(dataDir, { recursive: true })
    connection = new Database(databasePath)
    connection.pragma("journal_mode = WAL")
    connection.pragma("foreign_keys = ON")
    connection.pragma("busy_timeout = 5000")
    migrateHiveSchema(connection)
    const integrity = String(connection.pragma("integrity_check", { simple: true }))

    if (integrity !== "ok") {
      throw new Error(`SQLite integrity check failed: ${integrity}`)
    }

    currentHealth = { status: "ready", path: databasePath }
  } catch (error) {
    connection?.close()
    connection = undefined
    currentHealth = {
      status: "unavailable",
      path: databasePath,
      reason: error instanceof Error ? error.message : String(error)
    }
  }

  function requireConnection() {
    if (!connection || currentHealth.status !== "ready") {
      const reason = currentHealth.status === "ready" ? "connection closed" : currentHealth.reason
      throw new Error(`Hive memory unavailable: ${reason}`)
    }

    return connection
  }

  function enqueue<T>(operation: () => T) {
    const next = writeQueue.then(operation, operation)
    writeQueue = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  return {
    read<T>(operation: (database: Database.Database) => T) {
      return operation(requireConnection())
    },
    write<T>(operation: (database: Database.Database) => T) {
      return enqueue(() => operation(requireConnection()))
    },
    transaction<T>(operation: (database: Database.Database) => T) {
      return enqueue(() => {
        const database = requireConnection()
        return database.transaction(() => operation(database))()
      })
    },
    health() {
      return currentHealth
    },
    schemaVersion() {
      if (!connection) return 0
      return (connection.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get() as { version: number }).version
    },
    pragma(name) {
      return String(requireConnection().pragma(name, { simple: true }))
    },
    close() {
      connection?.close()
      connection = undefined
    }
  }
}

export { hiveSchemaVersion }
