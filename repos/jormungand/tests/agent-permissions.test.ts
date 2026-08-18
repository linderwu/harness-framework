import assert from "node:assert/strict"
import test from "node:test"
import {
  getAgentPermissionMode,
  isFullAgentPermissionMode
} from "../lib/agent-permissions"

test("agent permission mode defaults to full when unset or unknown", () => {
  assert.equal(getAgentPermissionMode(undefined), "full")
  assert.equal(getAgentPermissionMode("unknown"), "full")
})

test("agent permission mode preserves restricted mode", () => {
  assert.equal(getAgentPermissionMode("restricted"), "restricted")
})

test("full agent permission mode detection is explicit", () => {
  assert.equal(isFullAgentPermissionMode("full"), true)
  assert.equal(isFullAgentPermissionMode("restricted"), false)
})
