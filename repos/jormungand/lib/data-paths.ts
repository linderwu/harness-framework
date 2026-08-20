import { resolve } from "node:path"

export interface DataPathEnv {
  JORMUNGAND_DATA_DIR?: string
}

export function getConfiguredDataDir(env: NodeJS.ProcessEnv = process.env) {
  return resolve(/* turbopackIgnore: true */ env.JORMUNGAND_DATA_DIR?.trim() || resolve(process.cwd(), "data"))
}

export function getWorkflowStatePath(env: NodeJS.ProcessEnv = process.env) {
  return resolve(getConfiguredDataDir(env), "harness-state.json")
}

export function getHiveDatabasePath(env: NodeJS.ProcessEnv = process.env) {
  return resolve(getConfiguredDataDir(env), "hive-memory.sqlite")
}

export function getLegacyWorkflowStatePath() {
  return resolve(process.cwd(), "data", "harness-state.json")
}
