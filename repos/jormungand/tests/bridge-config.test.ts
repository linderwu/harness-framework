import { existsSync, readFileSync } from "node:fs"
import { test } from "node:test"
import { strict as assert } from "node:assert"

const exampleConfig = JSON.parse(
  readFileSync(".harness/bridge.config.example.json", "utf8")
) as Record<string, unknown>
const configLoader = existsSync("scripts/bridge-config.mjs")
  ? readFileSync("scripts/bridge-config.mjs", "utf8")
  : ""
const codexBridge = readFileSync("scripts/codex-bridge.mjs", "utf8")
const luckyBridge = readFileSync("scripts/lucky-mavis-server.mjs", "utf8")

test("bridge config is device-first for the Codex device runtimes", () => {
  assert.equal(exampleConfig.schemaVersion, 1)
  assert.ok(exampleConfig.device)
  assert.ok(exampleConfig.bridge)
  assert.ok(exampleConfig.runtimes)
  assert.ok(exampleConfig.secrets)
  assert.equal("bridges" in exampleConfig, false)

  const runtimes = exampleConfig.runtimes as Record<string, unknown>
  assert.ok(runtimes.codex)
  assert.ok(runtimes.lucky)
  assert.equal("openclaw" in runtimes, false)
})

test("Codex and Lucky bridge processes share the device config loader", () => {
  assert.match(configLoader, /export function loadBridgeConfig\(/)
  assert.match(codexBridge, /loadBridgeConfig\(/)
  assert.match(luckyBridge, /loadBridgeConfig\(/)
})
