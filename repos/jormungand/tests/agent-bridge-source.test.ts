import { readFileSync } from "node:fs"
import { test } from "node:test"
import { strict as assert } from "node:assert"

const bridge = readFileSync("lib/agent-bridge.ts", "utf8")

test("OpenClaw A2A control sends a standalone slash stop message", () => {
  assert.match(bridge, /sendOpenClawA2AControl/)
  assert.match(bridge, /OPENCLAW_A2A_CONTROL_MESSAGE/)
  assert.match(bridge, /"\/stop"/)
  assert.match(bridge, /OPENCLAW_A2A_SESSION_KEY/)
  assert.match(bridge, /OPENCLAW_A2A_AGENT/)
})
