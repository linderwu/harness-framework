import assert from "node:assert/strict"
import test from "node:test"

process.env.OPENCLAW_BRIDGE_DISABLE_LISTEN = "1"
const { buildOpenClawInvocation } = await import("./openclaw-bridge.mjs")

test("native mode invokes the host OpenClaw CLI without Docker", () => {
  assert.deepEqual(
    buildOpenClawInvocation({
      executionMode: "host",
      executable: "/opt/openclaw",
      container: "openclaw",
      siteAuth: { username: "site-user", password: "site-pass" },
      agentArgs: ["agent", "--agent", "rowlet", "--json"]
    }),
    {
      command: "/opt/openclaw",
      args: ["agent", "--agent", "rowlet", "--json"]
    }
  )
})
