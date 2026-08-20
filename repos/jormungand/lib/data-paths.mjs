import { resolve } from "node:path"

export function getConfiguredDataDir(env = process.env) {
  return resolve(env.JORMUNGAND_DATA_DIR?.trim() || resolve(process.cwd(), "data"))
}

export function getWorkflowStatePath(env = process.env) {
  return resolve(getConfiguredDataDir(env), "harness-state.json")
}

export function getHiveDatabasePath(env = process.env) {
  return resolve(getConfiguredDataDir(env), "hive-memory.sqlite")
}
