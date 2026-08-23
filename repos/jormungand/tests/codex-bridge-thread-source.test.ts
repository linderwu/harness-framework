import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const bridgeSource = readFileSync("scripts/codex-bridge.mjs", "utf8")

test("Codex bridge uses the resumable App Server session adapter", () => {
  assert.match(bridgeSource, /codex-app-server-session\.mjs/)
  assert.match(bridgeSource, /threadId: typeof payload\.threadId === "string"/)
  assert.match(bridgeSource, /name: typeof payload\.name === "string"/)
  assert.match(bridgeSource, /createCodexAppServerSession\(/)
})

test("Codex bridge exposes native thread snapshots and lifecycle operations", () => {
  assert.match(bridgeSource, /codexSessionMatch/)
  assert.match(bridgeSource, /action === "thread"/)
  assert.match(bridgeSource, /appServerSession\.readThread\(\)/)
  assert.match(bridgeSource, /appServerSession\.rename\(name\)/)
  assert.match(bridgeSource, /appServerSession\.archive\(\)/)
  assert.match(bridgeSource, /appServerSession\.unarchive\(\)/)
  assert.match(bridgeSource, /appServerSession\.delete\(\)/)
  assert.match(bridgeSource, /name\.length > 120/)
  assert.match(bridgeSource, /error\.httpStatus = 404/)
  assert.match(bridgeSource, /isMissingNativeThreadError/)
})
