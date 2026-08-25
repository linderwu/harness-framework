import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import test from "node:test"

const launcher = readFileSync(resolve("..", "..", "START-POKEMON-CENTER-SERVER.cmd"), "utf8")
const script = readFileSync("scripts/start-pokemon-center-server.ps1", "utf8")

test("Pokemon Center launcher forwards restart mode to the managed server script", () => {
  assert.match(launcher, /%~1/i)
  assert.match(launcher, /-Restart/i)
  assert.match(script, /\[switch\]\$Restart/i)
  assert.match(script, /Stop-ManagedService/i)
})
