import { readFileSync } from "node:fs"
import { test } from "node:test"
import { strict as assert } from "node:assert"

const dashboard = readFileSync("components/harness-dashboard.tsx", "utf8")

function functionBody(functionName: string) {
  const start = dashboard.indexOf(`function ${functionName}(`)

  assert.notEqual(start, -1, `Expected ${functionName} to exist`)

  const nextFunction = dashboard.indexOf("\nfunction ", start + 1)

  return dashboard.slice(start, nextFunction === -1 ? undefined : nextFunction)
}

test("run detail does not repeat the project hero summary", () => {
  const runDetail = functionBody("RunDetail")

  assert.doesNotMatch(runDetail, /className="panel heroPanel"/)
})

test("run detail does not repeat the project progress timeline", () => {
  const runDetail = functionBody("RunDetail")

  assert.doesNotMatch(runDetail, /className="panel timelinePanel"/)
})

test("dashboard uses project selector instead of an always-expanded project list", () => {
  assert.match(dashboard, /<ProjectSelector/)
  assert.match(dashboard, /function ProjectSelector\(/)
  assert.doesNotMatch(
    dashboard,
    /projects\.map\(\(project\) =>\s*\(\s*<button[\s\S]*className=\{[\s\S]*runRow active/
  )
})

test("project selector selection uses the latest run from the selector item", () => {
  const dashboardShell = dashboard.slice(
    dashboard.indexOf("<ProjectSelector"),
    dashboard.indexOf("</section>", dashboard.indexOf("<ProjectSelector"))
  )

  assert.match(dashboardShell, /setSelectedProjectId\(item\.project\.id\)/)
  assert.match(dashboardShell, /setSelectedRunId\(item\.latestRun\?\.id\)/)
})

test("dashboard has a bridge health endpoint contract", () => {
  const route = readFileSync("app/api/agent-health/route.ts", "utf8")

  assert.match(route, /export async function GET\(\)/)
  assert.match(route, /codex-bridge/)
  assert.match(route, /openclaw-bridge/)
  assert.match(route, /openclaw-a2a/)
  assert.match(route, /not_configured/)
})

test("dashboard renders the bridge status panel with the selected run", () => {
  assert.match(dashboard, /<BridgeStatusPanel\s+run=\{selectedRun\}/)
  assert.match(dashboard, /function BridgeStatusPanel\(/)
})

test("bridge status panel groups agents by bridge", () => {
  const panel = functionBody("BridgeStatusPanel")

  assert.match(panel, /bridgeDefinitions\.map/)
  assert.match(panel, /BridgeStatusCard/)
  assert.doesNotMatch(panel, /agentProfiles\.map\(\(agent\) =>\s*<BridgeStatusCard/)
})

test("bridge status polling and stale thresholds match the accepted design", () => {
  assert.match(dashboard, /const bridgeHealthPollIntervalMs = 10_000/)
  assert.match(dashboard, /const bridgeHealthStaleAfterMs = 30_000/)
  assert.match(dashboard, /const bridgeOfflineFailureThreshold = 2/)
})
