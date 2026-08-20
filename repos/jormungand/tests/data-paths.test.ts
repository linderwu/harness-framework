import assert from "node:assert/strict"
import { join, resolve } from "node:path"
import test from "node:test"
import {
  getConfiguredDataDir,
  getHiveDatabasePath,
  getWorkflowStatePath
} from "../lib/data-paths"

test("data path helpers resolve every runtime file under the injected data root", () => {
  const defaultEnv = {} as unknown as NodeJS.ProcessEnv
  const env = {
    JORMUNGAND_DATA_DIR: resolve(process.cwd(), ".tmp-tests", "runtime-boundary-root")
  } as unknown as NodeJS.ProcessEnv

  assert.equal(getConfiguredDataDir(defaultEnv), resolve(process.cwd(), "data"))
  assert.equal(getWorkflowStatePath(defaultEnv), join(resolve(process.cwd(), "data"), "harness-state.json"))
  assert.equal(getHiveDatabasePath(defaultEnv), join(resolve(process.cwd(), "data"), "hive-memory.sqlite"))

  const configuredDataDir = getConfiguredDataDir(env)

  assert.equal(configuredDataDir, env.JORMUNGAND_DATA_DIR)
  assert.equal(getWorkflowStatePath(env), join(configuredDataDir, "harness-state.json"))
  assert.equal(getHiveDatabasePath(env), join(configuredDataDir, "hive-memory.sqlite"))
})
