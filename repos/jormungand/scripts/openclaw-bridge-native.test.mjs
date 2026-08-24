import assert from "node:assert/strict"
import test from "node:test"

process.env.OPENCLAW_BRIDGE_DISABLE_LISTEN = "1"
const { buildOpenClawInvocation } = await import("./openclaw-bridge.mjs")

test("host mode invokes native OpenClaw without Docker", () => {
  const invocation = buildOpenClawInvocation({
    executionMode: "host",
    executable: { command: "/opt/openclaw", args: [] },
    dockerCommand: { command: "docker", args: [] },
    container: "openclaw",
    agentArgs: ["agent", "--agent", "rowlet", "--json"]
  })

  assert.deepEqual(invocation, {
    command: "/opt/openclaw",
    args: ["agent", "--agent", "rowlet", "--json"]
  })
})
