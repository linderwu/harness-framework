import { resolve } from "node:path"

export interface DataPathEnv {
  JORMUNGAND_DATA_DIR?: string
  [key: string]: string | undefined
}

export function getConfiguredDataDir(env: DataPathEnv = process.env) {
  return resolve(/* turbopackIgnore: true */ env.JORMUNGAND_DATA_DIR?.trim() || resolve(process.cwd(), "data"))
}

export function getWorkflowStatePath(env: DataPathEnv = process.env) {
  return resolve(getConfiguredDataDir(env), "harness-state.json")
}

export function getHiveDatabasePath(env: DataPathEnv = process.env) {
  return resolve(getConfiguredDataDir(env), "hive-memory.sqlite")
}

export function getLegacyWorkflowStatePath() {
  return resolve(process.cwd(), "data", "harness-state.json")
}
