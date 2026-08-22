import { readFileSync } from "node:fs"
import { test } from "node:test"
import { strict as assert } from "node:assert"

const dashboard = readFileSync("components/harness-dashboard.tsx", "utf8")
const luckyProxy = readFileSync("app/api/lucky/[...path]/route.ts", "utf8")
const luckyRoute = readFileSync("app/api/lucky/route.ts", "utf8")

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
  assert.doesNotMatch(route, /minimax-bridge/)
  assert.match(route, /urlHost/)
  assert.doesNotMatch(route, /OPENCLAW_A2A_COMMAND/)
  assert.doesNotMatch(route, /openclaw-a2a/)
  assert.doesNotMatch(route, /Manual \/ Simulated/)
  assert.doesNotMatch(route, /not_configured/)
})

test("Lucky compatibility routes use the shared Codex device bridge", () => {
  assert.match(luckyProxy, /CODEX_BRIDGE_URL/)
  assert.match(luckyProxy, /CODEX_BRIDGE_TOKEN/)
  assert.doesNotMatch(luckyProxy, /LUCKY_BRIDGE_URL/)
  assert.doesNotMatch(luckyProxy, /LUCKY_BRIDGE_TOKEN/)
  assert.match(luckyRoute, /CODEX_BRIDGE_URL/)
  assert.doesNotMatch(luckyRoute, /LUCKY_BRIDGE_URL/)
})

test("topbar refresh control reloads the complete dashboard page", () => {
  const topbarStart = dashboard.indexOf('<header className="topbar">')
  const topbarEnd = dashboard.indexOf("</header>", topbarStart)
  const topbar = dashboard.slice(topbarStart, topbarEnd)

  assert.match(topbar, /aria-label="Reload page"/)
  assert.match(topbar, /title="Reload page"/)
  assert.match(topbar, /onClick=\{\(\) => window\.location\.reload\(\)\}/)
})

test("dashboard renders bridge status inside the right monitoring rail", () => {
  const composePanel = dashboard.slice(
    dashboard.indexOf('<form className="panel composePanel"'),
    dashboard.indexOf(
      "</form>",
      dashboard.indexOf('<form className="panel composePanel"')
    )
  )
  const workspace = dashboard.slice(
    dashboard.indexOf('className="taskWorkspaceGrid"'),
    dashboard.indexOf("</main>")
  )

  assert.doesNotMatch(composePanel, /<BridgeStatusPanel/)
  assert.match(workspace, /<TaskStatusSidebar[\s\S]*run=\{selectedRun\}/)
  assert.doesNotMatch(workspace, /No active task\.[\s\S]*<BridgeStatusPanel \/>/)
})

test("bridge status panel renders endpoint bridges instead of fixed bridge definitions", () => {
  const panel = functionBody("BridgeStatusPanel")

  assert.match(panel, /visibleBridges\.map/)
  assert.match(panel, /getBridgeAgents\(bridge\.id\)/)
  assert.doesNotMatch(dashboard, /const bridgeDefinitions/)
  assert.doesNotMatch(dashboard, /openclaw-a2a/)
  assert.doesNotMatch(dashboard, /minimax-bridge/)
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

test("workflow mutation errors surface failed-run diagnostics", () => {
  assert.match(dashboard, /response\.status === 409 && "latestRun" in data && data\.latestRun/)

  const route = readFileSync(
    "app/api/projects/[id]/workflow-runs/route.ts",
    "utf8"
  )
  assert.match(route, /console\.error\("Managed workflow start failed"/)
  assert.match(route, /\{ error: message, latestRun: failedRun \}/)
})

test("workflow creation clients retain queued job ids instead of assuming immediate runs", () => {
  assert.match(dashboard, /response\.status === 202/)
  assert.match(dashboard, /jobId/)
  assert.match(dashboard, /queued/)
  assert.match(dashboard, /reportWorkflowRunJobResult\(run, undefined, "Workflow run"\)/)
})

test("workflow actions keep durable job envelopes out of run selection", () => {
  assert.match(
    dashboard,
    /type WorkflowRunJobStatus = "queued" \| "running" \| "completed" \| "failed" \| "canceled"/
  )
  assert.match(dashboard, /function isWorkflowRunJobResult\(result: unknown\)/)
  assert.match(dashboard, /if \(isWorkflowRunJobResult\(data\)\) \{\s*return data/)
  assert.match(dashboard, /function reportWorkflowRunJobResult\(/)
  assert.match(dashboard, /result\.status === "failed"/)
  assert.match(dashboard, /result\.jobId/)
  assert.match(dashboard, /reportWorkflowRunJobResult\(run, undefined, "Workflow run"\)/)
  assert.match(dashboard, /reportWorkflowRunJobResult\(run, runId, "Workflow run update"\)/)
  assert.match(dashboard, /reportWorkflowRunJobResult\(nextRun, run\.id, "Workflow run cancellation"\)/)
  assert.match(dashboard, /reportWorkflowRunJobResult\(run, selectedRun\?\.id, "Approval gate decision"\)/)
})

test("workflow run submissions send idempotency keys", () => {
  assert.match(
    dashboard,
    /function createWorkflowRunIdempotencyKey\(\) \{\s*return \(\s*globalThis\.crypto\?\.randomUUID\?\.\(\)/
  )
  assert.match(dashboard, /workflow-run-\$\{Date\.now\(\)\}/)
  assert.equal(
    (dashboard.match(/"Idempotency-Key": createWorkflowRunIdempotencyKey\(\)/g) ?? []).length,
    2
  )
})

test("bridge status panel polls quotas and forwards only codex quota to the Arceus row", () => {
  const panel = functionBody("BridgeStatusPanel")
  const card = functionBody("BridgeStatusCard")
  const row = functionBody("AgentBridgeRow")
  const quotaBar = functionBody("AgentQuotaBar")

  assert.match(panel, /const agentQuotaPollIntervalMs = 5 \* 60 \* 1000/)
  assert.match(panel, /refreshCodexQuota/)
  assert.match(panel, /bridge.id === "codex-bridge" \? codexQuota : undefined/)
  assert.match(card, /isOpenClawAgent\(agent\)/)
  assert.match(
    row,
    /windowLabel=\{agent === \"codex\" \? \"Weekly\" : \"5h\"\}/
  )
  assert.match(quotaBar, /role="progressbar"/)
  assert.match(quotaBar, /\{windowLabel\} HP/)
  assert.match(quotaBar, /\$\{remainingPercent\}%/)
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
  assert.match(dashboard, /!isAgentTask && !isArceusMaintenance \? \(\s*<label>\s*<span>Repository<\/span>/)
})

test("compose form sends the complete Arceus maintenance contract", () => {
  assert.match(dashboard, /const isArceusMaintenance = form\.projectType === "arceus_maintenance"/)
  assert.match(dashboard, /successCriteria: splitLines\(form\.successCriteria\)/)
  assert.match(dashboard, /constraints: splitLines\(form\.constraints\)/)
  assert.match(dashboard, /nonGoals: splitLines\(form\.nonGoals\)/)
  assert.match(dashboard, /isArceusMaintenance \? \([\s\S]*Success criteria[\s\S]*Constraints[\s\S]*Non-goals/)
  assert.match(dashboard, /required=\{isArceusMaintenance\}/)
})

test("Arceus maintenance does not show repository field text", () => {
  assert.match(dashboard, /projectType === "agent_task" \|\| projectType === "arceus_maintenance"/)
  assert.match(dashboard, /!isAgentTask && !isArceusMaintenance/)
  assert.doesNotMatch(dashboard, /Repository is fixed by JORMUNGAND_REPOSITORY/)
})

test("compose form uses research-specific workflow skills", () => {
  assert.match(dashboard, /createResearchEventSkills/)
  assert.match(dashboard, /function getAssignableEventSkills\(projectType: ProjectType\)/)
  assert.match(dashboard, /projectType === "research"/)
  assert.match(dashboard, /skill\.id !== "intake\.requirement" && skill\.id !== "closeout\.archive"/)
  assert.match(dashboard, /const hasApprovalPolicies = form\.projectType === "development"/)
  assert.match(dashboard, /"Agent \/ Skills"/)
  assert.match(dashboard, /superpowersSkills/)
  assert.match(dashboard, /stageAssignments: form\.stageAssignments/)
})

test("compose form does not expose configurable approval actor fields", () => {
  assert.doesNotMatch(dashboard, /Design Approval Policy/)
  assert.doesNotMatch(dashboard, /Verification Approval Policy/)
  assert.doesNotMatch(dashboard, /function ActorSelect/)
})

test("dashboard exposes all project modes in a topmost global navigator", () => {
  const composePanel = dashboard.slice(
    dashboard.indexOf('<form className="panel composePanel"'),
    dashboard.indexOf(
      '<button\n            className="composeLaunchButton"',
      dashboard.indexOf('<form className="panel composePanel"')
    )
  )

  const globalNavIndex = dashboard.indexOf("<GlobalModeNav")
  const headerIndex = dashboard.indexOf('<header className="topbar">')
  assert.ok(globalNavIndex > -1 && globalNavIndex < headerIndex)
  assert.doesNotMatch(dashboard, /modeEdgeButton/)
  assert.doesNotMatch(composePanel, /modeSurface|modeDock/)
  assert.match(dashboard, /value=\{form\.projectType\}/)
  assert.match(dashboard, /className=\{`shell mode-\$\{form\.projectType\}`\}/)
})

test("global navigator renders the shared nine-mode option list", () => {
  const globalNav = readFileSync("components/global-mode-nav.tsx", "utf8")
  assert.match(globalNav, /projectTypeOptions\.map/)
  assert.match(globalNav, /className="globalModeDragonHead"/)
  assert.match(globalNav, /alt=""/)
  assert.match(globalNav, /aria-hidden="true"/)
  assert.match(globalNav, /aria-pressed=\{selected\}/)
  assert.match(globalNav, /scrollIntoView/)
  assert.doesNotMatch(globalNav, /const projectTypeOptions/)
})

test("selected task uses a conversation-first three-column workspace", () => {
  assert.match(dashboard, /className="taskWorkspaceGrid"/)
  assert.match(dashboard, /<TaskConversation[\s\S]*<TaskStatusSidebar/)
  assert.match(dashboard, /<ProjectSelector[\s\S]*className="panel composePanel"/)
  assert.match(dashboard, /initialEntries=/)
  assert.match(dashboard, /allowedAgents=/)
})

test("workspace rails collapse inward and preserve the conversation column", () => {
  assert.match(dashboard, /const \[isNavigationExpanded, setIsNavigationExpanded\] = useState\(true\)/)
  assert.match(dashboard, /const \[isMonitoringExpanded, setIsMonitoringExpanded\] = useState\(true\)/)
  assert.match(dashboard, /data-left-collapsed=\{!isNavigationExpanded\}/)
  assert.doesNotMatch(dashboard, /data-right-collapsed=/)
  assert.match(dashboard, /aria-expanded=\{isNavigationExpanded\}/)
  assert.match(dashboard, /isNavigationExpanded \? <>[\s\S]*<ChevronDown[\s\S]*: <ChevronRight/)

  const sidebar = readFileSync("components/task-status-sidebar.tsx", "utf8")
  assert.match(sidebar, /isExpanded: boolean/)
  assert.match(sidebar, /taskMonitoringPanel/)
  assert.match(sidebar, /isExpanded \? <>[\s\S]*<ChevronDown[\s\S]*: <ChevronLeft/)
})

test("right monitoring rail keeps role cards and independently collapsible bridge connections", () => {
  const sidebar = readFileSync("components/task-status-sidebar.tsx", "utf8")
  assert.match(sidebar, /title="Agent Role Status"/)
  assert.match(sidebar, /className="agentRoleStatusCard"/)
  assert.match(sidebar, /getAgentRole\(/)
  assert.match(sidebar, /bridgeConnectionsPanel/)
  assert.match(sidebar, /const \[isBridgeExpanded, setIsBridgeExpanded\] = useState\(true\)/)
  assert.match(sidebar, /setIsBridgeExpanded\(\(current\) => !current\)/)
  assert.match(sidebar, /function BridgeConnectionsPanel/)
  assert.doesNotMatch(sidebar, /<MonitoringSection icon=\{<Network/)
})

test("task conversation is durable, targeted, and polls only while pending", () => {
  const conversationSource = readFileSync("components/task-conversation.tsx", "utf8")
  assert.match(conversationSource, /crypto\.randomUUID\(\)/)
  assert.match(conversationSource, /targetAgent/)
  assert.match(conversationSource, /queued|running/)
  assert.match(conversationSource, /3_000/)
  assert.match(conversationSource, /\/conversation/)
  assert.match(conversationSource, /artifactIds/)
  assert.match(conversationSource, /memoryIds/)
  assert.match(conversationSource, /response\.status === 202/)
  assert.match(conversationSource, /jobId/)
  assert.match(conversationSource, /queued/)
  assert.match(conversationSource, /setStatusMessage\(/)
})

test("conversation composer sends on Enter but preserves Shift+Enter and IME composition", () => {
  const conversationSource = readFileSync("components/task-conversation.tsx", "utf8")
  assert.match(conversationSource, /function handleComposerKeyDown\(event: KeyboardEvent<HTMLTextAreaElement>\)/)
  assert.match(conversationSource, /event\.shiftKey \|\| event\.nativeEvent\.isComposing \|\| event\.keyCode === 229/)
  assert.match(conversationSource, /event\.preventDefault\(\)/)
  assert.match(conversationSource, /onKeyDown=\{handleComposerKeyDown\}/)
  assert.match(conversationSource, /if \(!message \|\| allowedAgents\.length === 0 \|\| !activeConversationId \|\| isLoadingConversation \|\| isStartingConversation\) return/)
})

test("conversation remains available without a selected project and can adopt manager binding", () => {
  assert.match(dashboard, /const \[conversationVersion, setConversationVersion\] = useState\(0\)/)
  assert.match(dashboard, /key=\{`\$\{selectedRun\?\.id \?\? "unbound"\}:\$\{conversationVersion\}`\}/)
  assert.match(dashboard, /onBound=\{\(binding\)/)
  assert.match(dashboard, /setSelectedProjectId\(binding\.projectId\)/)
  assert.match(dashboard, /setSelectedRunId\(binding\.workflowRunId\)/)

  const conversationSource = readFileSync("components/task-conversation.tsx", "utf8")
  assert.match(conversationSource, /run\?: WorkflowRun/)
  assert.match(conversationSource, /"\/api\/conversation"/)
  assert.match(conversationSource, /No project or task/)
  assert.match(conversationSource, /Ask Codex to inspect or use the harness/)
})
