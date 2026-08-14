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

test("dashboard health endpoint only returns registered HTTP bridge URL records", () => {
  const route = readFileSync("app/api/agent-health/route.ts", "utf8")

  assert.match(route, /CODEX_BRIDGE_URL/)
  assert.match(route, /OPENCLAW_BRIDGE_URL/)
  assert.match(route, /urlHost/)
  assert.doesNotMatch(route, /OPENCLAW_A2A_COMMAND/)
  assert.doesNotMatch(route, /openclaw-a2a/)
  assert.doesNotMatch(route, /Manual \/ Simulated/)
  assert.doesNotMatch(route, /not_configured/)
})

test("dashboard renders bridge status inside the compose panel action area", () => {
  const composePanel = dashboard.slice(
    dashboard.indexOf('<form className="panel composePanel"'),
    dashboard.indexOf(
      "</form>",
      dashboard.indexOf('<form className="panel composePanel"')
    )
  )
  const actionRowIndex = composePanel.indexOf('className="runActionRow"')
  const bridgePanelIndex = composePanel.indexOf("<BridgeStatusPanel")
  const errorIndex = composePanel.indexOf("{mutationError ?")

  assert.ok(actionRowIndex > -1, "Expected action row in compose panel")
  assert.ok(bridgePanelIndex > actionRowIndex, "Expected bridge panel after action row")
  assert.ok(errorIndex > bridgePanelIndex, "Expected mutation error after bridge panel")
  assert.doesNotMatch(
    dashboard.slice(dashboard.indexOf("</section>"), dashboard.indexOf("</main>")),
    /<BridgeStatusPanel/
  )
})

test("bridge status panel renders endpoint bridges instead of fixed bridge definitions", () => {
  const panel = functionBody("BridgeStatusPanel")

  assert.match(panel, /visibleBridges\.map/)
  assert.match(panel, /getBridgeAgents\(bridge\.id\)/)
  assert.doesNotMatch(dashboard, /const bridgeDefinitions/)
  assert.doesNotMatch(dashboard, /openclaw-a2a/)
  assert.doesNotMatch(dashboard, /Manual \/ Simulated/)
})

test("bridge cards include the complete OpenClaw roster", () => {
  const cardRoster = functionBody("getBridgeAgents")

  assert.match(cardRoster, /openclaw\.rowlet/)
  assert.match(cardRoster, /openclaw\.roaringmoon/)
  assert.match(cardRoster, /openclaw\.mrmime/)
  assert.match(cardRoster, /openclaw\.gengar/)
  assert.doesNotMatch(cardRoster, /openclaw\.mrmine/)
})

test("bridge status polling and stale thresholds match the accepted design", () => {
  assert.match(dashboard, /const bridgeHealthPollIntervalMs = 10_000/)
  assert.match(dashboard, /const bridgeHealthStaleAfterMs = 30_000/)
  assert.match(dashboard, /const bridgeOfflineFailureThreshold = 2/)
})

test("agent run rows expose a stop button for active task runs", () => {
  const runDetail = functionBody("RunDetail")

  assert.match(runDetail, /onStopRun/)
  assert.match(runDetail, /isActiveAgentRunStatus\(agentRun\.status\)/)
  assert.match(runDetail, /title="Stop task"/)
  assert.match(runDetail, /Stop task/)
})

test("run detail exposes cancel run for nonterminal selected runs", () => {
  const runDetail = functionBody("RunDetail")

  assert.match(runDetail, /onCancelRun/)
  assert.match(runDetail, /isCancelableStatus\(run\.status\)/)
  assert.match(runDetail, /title="Cancel run"/)
})

test("compose form gives agent task projects a one-step instruction flow", () => {
  assert.match(dashboard, /const isAgentTask = form\.projectType === "agent_task"/)
  assert.match(dashboard, /isAgentTask \? "Instruction" : "Requirement"/)
  assert.match(dashboard, /isAgentTask \? "Run Task" : "Create Project"/)
  assert.match(dashboard, /!\s*isAgentTask \? \(\s*<label>\s*<span>Repository<\/span>/)
})

test("compose form uses research-specific workflow skills", () => {
  assert.match(dashboard, /createResearchEventSkills/)
  assert.match(dashboard, /function getAssignableEventSkills\(projectType: ProjectType\)/)
  assert.match(dashboard, /projectType === "research"/)
  assert.match(dashboard, /skill\.id !== "intake\.requirement" && skill\.id !== "closeout\.archive"/)
  assert.match(dashboard, /const hasApprovalPolicies = form\.projectType === "development"/)
  assert.match(dashboard, /"Agent \/ Skills"/)
  assert.match(dashboard, /\{hasApprovalPolicies \? \(/)
  assert.match(dashboard, /assignmentStages\.includes\(stage\)/)
})

test("compose panel exposes all project modes as a global mode surface", () => {
  const composePanel = dashboard.slice(
    dashboard.indexOf('<form className="panel composePanel"'),
    dashboard.indexOf(
      '<button\n            className="composeLaunchButton"',
      dashboard.indexOf('<form className="panel composePanel"')
    )
  )

  assert.match(dashboard, /className="modeEdgeButton modeEdgeButtonLeft"/)
  assert.match(dashboard, /className="modeEdgeButton modeEdgeButtonRight"/)
  assert.match(composePanel, /className="modeSurface"/)
  assert.match(composePanel, /className="modeDock"/)
  assert.match(composePanel, /projectTypeOptions.map/)
  assert.match(composePanel, /aria-label=\{option\.label\}/)
  assert.match(dashboard, /className=\{`shell mode-\$\{form\.projectType\}`\}/)
})
