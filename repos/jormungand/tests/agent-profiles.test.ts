import assert from "node:assert/strict"
import test from "node:test"
import { agentProfiles, normalizeAgentKind } from "../lib/agents"

test("manual is not offered as an executor profile", () => {
  assert.equal(
    agentProfiles.map((agent) => agent.id as string).includes("manual"),
    false
  )
  assert.deepEqual(
    agentProfiles.map((agent) => agent.family),
    [
      "codex",
      "openclaw",
      "openclaw",
      "openclaw",
      "openclaw",
      "openclaw",
      "openclaw"
    ]
  )
})

test("legacy manual executor values normalize to codex", () => {
  assert.equal(normalizeAgentKind("manual"), "codex")
})
