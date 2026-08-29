import { readFileSync } from "node:fs"
import { strict as assert } from "node:assert"
import { test } from "node:test"

const taskConversation = readFileSync("components/task-conversation.tsx", "utf8")
const dashboard = readFileSync("components/harness-dashboard.tsx", "utf8")
const conversationRoute = readFileSync("app/api/conversation/route.ts", "utf8")
const globalsCss = readFileSync("app/globals.css", "utf8")

test("task conversation keeps an active conversation id and sends it with unbound requests", () => {
  assert.match(taskConversation, /const \[conversationId, setConversationId\] = useState<string \| undefined>\(runId\)/)
  assert.doesNotMatch(taskConversation, /const defaultConversationId = runId \?\? "global:unbound-conversation"/)
  assert.match(taskConversation, /setConversationId\(data\.conversationId/)
  assert.match(taskConversation, /const activeConversationId = isUnbound \? conversationId : runId/)
  assert.match(taskConversation, /workflowRunId: activeConversationId/)
  assert.match(taskConversation, /body: JSON\.stringify\(buildConversationMessagePayload\(\{/)
  assert.match(taskConversation, /body: JSON\.stringify\(\{ action, conversationId: activeConversationId \}\)/)
})

test("task conversation exposes a new conversation action with pending reset behavior", () => {
  assert.match(taskConversation, /New conversation/)
  assert.match(taskConversation, /const \[isStartingConversation, setIsStartingConversation\] = useState\(false\)/)
  assert.match(taskConversation, /requestNewConversation\(fetch\)/)
  assert.match(taskConversation, /setEntries\(\[\]\)/)
  assert.match(taskConversation, /setSession\(undefined\)/)
  assert.match(taskConversation, /setEvents\(\[\]\)/)
  assert.match(taskConversation, /props\.onNewConversation\?\.\(/)
})

test("conversation submission stays gated until the server identity hydrates", () => {
  // Source-contract coverage protects the reload/remount race when GET has not issued the active ID yet.
  assert.match(taskConversation, /const \[isLoadingConversation, setIsLoadingConversation\] = useState\(true\)/)
  assert.match(taskConversation, /if \(!message \|\| allowedAgents\.length === 0 \|\| !activeConversationId \|\| isLoadingConversation \|\| isStartingConversation\) return/)
  assert.match(taskConversation, /if \(activeManagerAction\) return/)
  assert.match(taskConversation, /disabled=\{!content\.trim\(\) \|\| !allowedAgents\.length \|\| !activeConversationId \|\| isLoadingConversation \|\| isStartingConversation \|\| !!activeManagerAction\}/)
  assert.match(taskConversation, /if \(requireConversationId && !data\.conversationId\) \{[\s\S]*throw new Error\(/)
})

test("new conversation invalidates stale poll responses before they can write state", () => {
  assert.match(taskConversation, /const requestGeneration = useRef\(0\)/)
  assert.match(taskConversation, /const generation = requestGeneration\.current/)
  assert.ok((taskConversation.match(/generation !== requestGeneration\.current/g) ?? []).length >= 2)
  assert.match(taskConversation, /function invalidateConversationRequests\(\) \{[\s\S]*requestGeneration\.current \+= 1[\s\S]*pollingInFlight\.current = undefined/)

  const startNewConversationIndex = taskConversation.indexOf("async function startNewConversation")
  assert.notEqual(startNewConversationIndex, -1)
  const startNewConversationBody = taskConversation.slice(startNewConversationIndex, taskConversation.indexOf("\n  const isTurnRunning", startNewConversationIndex))
  assert.match(startNewConversationBody, /invalidateConversationRequests\(\)/)
  assert.match(taskConversation, /useEffect\(\(\) => \(\) => \{[\s\S]*invalidateConversationRequests\(\)[\s\S]*\}, \[\]\)/)
})

test("conversation manager uses managed metadata, archived filtering, and explicit delete confirmation", () => {
  assert.match(taskConversation, /ConversationSummary/)
  assert.match(taskConversation, /ConversationState/)
  assert.match(taskConversation, /const \[conversations, setConversations\] = useState<ConversationSummary\[\]>\(\[\]\)/)
  assert.match(taskConversation, /const \[includeArchived, setIncludeArchived\] = useState\(false\)/)
  assert.match(taskConversation, /requestConversationSummaries\(fetch, includeArchived\)/)
  assert.match(taskConversation, /includeArchived=true/)
  assert.match(taskConversation, /export async function requestConversationDeletionAndReplacement/)
  assert.match(taskConversation, /body: JSON\.stringify\(\{ confirm: true \}\)/)
})

test("unbound Codex model state uses existing metadata and selector data flow", () => {
  assert.match(taskConversation, /"conversationId" \| "title" \| "state" \| "selectedModelId"/)
  assert.match(taskConversation, /setMetadata\(data\.metadata\)/)
  assert.match(taskConversation, /onUnboundConversationStateChange/)
  assert.match(taskConversation, /requestConversationModel/)
  assert.match(dashboard, /unboundConversationState/)
  assert.match(dashboard, /onUnboundCodexModelChange/)
  assert.match(dashboard, /unboundSelectedModelId/)
})

test("unbound model persistence is limited to model selection changes", () => {
  assert.match(dashboard, /applyProfile\(nextModelId, selectedReasoningIntensity, true\)/)
  assert.match(dashboard, /applyProfile\(selectedModelId, nextReasoningIntensity\)/)
})

test("unbound submit carries the parent model state through the POST contract", () => {
  assert.match(taskConversation, /unboundSelectedModelId\?: string/)
  assert.match(taskConversation, /selectedModelId: isUnbound && targetAgent === "codex" \? props\.unboundSelectedModelId : undefined/)
  assert.match(dashboard, /unboundSelectedModelId=\{unboundConversationState\?\.selectedModelId\}/)
  assert.match(conversationRoute, /selectedModelId\?: unknown/)
  assert.match(conversationRoute, /selectedModelId: body\.selectedModelId/)
})

test("conversation header surfaces the managed title, access mode, dialog copy, and action labels", () => {
  assert.match(taskConversation, /metadata\?\.title/)
  assert.match(taskConversation, /permissionMode/)
  assert.match(taskConversation, /Full access/)
  assert.match(taskConversation, /role="status"/)
  assert.match(taskConversation, /aria-label="Show archived conversations"/)
  assert.match(taskConversation, /aria-label="Rename conversation"/)
  assert.match(taskConversation, /aria-label="Delete conversation"/)
  assert.match(taskConversation, /<dialog/)
  assert.match(taskConversation, /Delete this conversation and its Codex session\?/)
})

test("conversation surfaces native Codex sync state without focus controls", () => {
  assert.match(taskConversation, /Codex sync/)
  assert.match(taskConversation, /formatCodexSyncStatus\(session\)/)
  assert.match(taskConversation, /replacement_pending/)
  assert.match(taskConversation, /Waiting for sync|Synced/)
  assert.doesNotMatch(taskConversation, /window\.focus\(|focusCodex|bring.*foreground/i)
})

test("openclaw live stream state stays ephemeral and uses the conversation SSE before post dispatch", () => {
  assert.match(taskConversation, /AgentLiveEvent/)
  assert.match(taskConversation, /const \[agentLiveEvents, setAgentLiveEvents\] = useState<AgentLiveEvent\[\]>\(\[\]\)/)
  assert.match(taskConversation, /const \[agentLiveReasoning, setAgentLiveReasoning\] = useState<string \| undefined>\(\)/)
  assert.match(taskConversation, /const \[agentLiveStatus, setAgentLiveStatus\] = useState<string \| undefined>\(\)/)
  assert.match(taskConversation, /const \[activeEventSource, setActiveEventSource\] = useState<EventSource \| undefined>\(\)/)
  assert.match(taskConversation, /if \(shouldOpenAgentLiveStream\(targetAgent, !isUnbound\)\)/)
  assert.match(taskConversation, /new EventSource\(buildConversationLivePath\(activeConversationId\)\)/)
  assert.match(taskConversation, /source\.addEventListener\("agent-live", handleAgentLiveEvent\)/)
  assert.match(taskConversation, /source\.addEventListener\("error", handleAgentLiveError\)/)
  assert.match(taskConversation, /const response = await fetch\(conversationPath, \{/)

  const startStreamIndex = taskConversation.indexOf('new EventSource(buildConversationLivePath(activeConversationId))')
  const postIndex = taskConversation.indexOf("const response = await fetch(conversationPath, {")
  assert.notEqual(startStreamIndex, -1)
  assert.notEqual(postIndex, -1)
  assert.ok(startStreamIndex < postIndex, "live SSE must be opened before the POST request is dispatched")
})

test("openclaw live stream cleanup closes listeners on terminal events and request lifecycle changes", () => {
  assert.match(taskConversation, /const agentLiveSubmissionLifecycleRef = useRef<\{ postPending: boolean; terminalEventReceived: boolean \} \| undefined>\(undefined\)/)
  assert.match(taskConversation, /agentLiveSubmissionLifecycleRef\.current = startAgentLiveSubmissionLifecycle\(\)/)
  assert.match(taskConversation, /advanceAgentLiveSubmissionLifecycle\(agentLiveSubmissionLifecycleRef\.current, event\)/)
  assert.match(taskConversation, /shouldIgnoreAgentLiveSourceError\(agentLiveSubmissionLifecycleRef\.current\)/)
  assert.match(taskConversation, /settleAgentLiveSubmissionLifecycle\(agentLiveSubmissionLifecycleRef\.current\)/)
  assert.match(taskConversation, /source\.removeEventListener\("agent-live", handleAgentLiveEvent\)/)
  assert.match(taskConversation, /source\.removeEventListener\("error", handleAgentLiveError\)/)
  assert.match(taskConversation, /source\.close\(\)/)
  assert.match(taskConversation, /if \(lifecycleResult\.shouldCloseSource\) \{[\s\S]*closeAgentLiveSource\(\)/)
  assert.match(taskConversation, /function invalidateConversationRequests\(\) \{[\s\S]*closeAgentLiveSource\(\)/)
  assert.match(taskConversation, /useEffect\(\(\) => \(\) => \{[\s\S]*closeAgentLiveSource\(\)[\s\S]*\}, \[\]\)/)
  assert.match(taskConversation, /} catch \(submitError\) \{[\s\S]*closeAgentLiveSource\(\)[\s\S]*setEntries\(/)
})

test("activity panel renders live agent preview details without changing codex controls", () => {
  assert.match(taskConversation, /Live Agent session/)
  assert.match(taskConversation, /Reasoning preview/)
  assert.match(taskConversation, /<details>/)
  assert.match(taskConversation, /<summary>Reasoning preview<\/summary>/)
  assert.match(taskConversation, /<pre className="codexLiveResponse" aria-live="polite">\{agentLiveReasoning\}<\/pre>/)
  assert.match(taskConversation, /const agentLiveVisibleEvents = agentLiveEvents[\s\S]*\.filter\(\(event\) => event\.type !== "assistant_delta"\)/)
  assert.match(taskConversation, /message: readAgentLiveMessage\(event\) \?\? "Agent activity"/)
  assert.match(taskConversation, /const agentLiveAssistantText = collectAgentLiveAssistantText\(agentLiveEvents\)/)
  assert.doesNotMatch(taskConversation, /\.join\(""\)\s*\.trim\(\)/)
  assert.match(taskConversation, /const \[activeAgentLiveSourceAgentId, setActiveAgentLiveSourceAgentId\] = useState<AgentKind \| undefined>\(\)/)
  assert.match(taskConversation, /const agentLivePanelState = getAgentLivePanelState\(\{/)
  assert.match(taskConversation, /hasActiveSubmission: !!agentLiveSubmissionLifecycleRef\.current/)
  assert.match(taskConversation, /const activityViewModel = getConversationActivityViewModel\(\{/)
  assert.match(taskConversation, /agentLivePanelState/)
  assert.match(taskConversation, /selectedAgentLabel/)
  assert.match(taskConversation, /\{isTurnRunning \? <button className="compactPanelButton"[\s\S]*>Pause<\/button> : null\}/)
  assert.match(taskConversation, /\{isPaused \? <button className="compactPanelButton"[\s\S]*>Continue<\/button> : null\}/)
  assert.match(taskConversation, /\{session\.status !== "stopped" && session\.status !== "failed" && \(isTurnRunning \|\| isPaused\) \? <button className="compactPanelButton danger"[\s\S]*>Stop<\/button> : null\}/)
})

test("bridge-backed live activity is not gated to unbound conversations and does not hide native Codex sessions", () => {
  assert.match(taskConversation, /const hasCodexSession = isUnbound && !!session/)
  assert.doesNotMatch(taskConversation, /const agentLiveActivityPanel = isUnbound && activityViewModel\.hasAgentLiveActivity/)
  assert.match(taskConversation, /showsCodexSession: input\.hasCodexSession/)
  assert.match(taskConversation, /shouldOpenAgentLiveStream\(targetAgent, !isUnbound\)/)
})

test("both live sessions share the dashboard-owned lower-left mount in Codex-first order", () => {
  assert.match(taskConversation, /liveActivityMount/)
  assert.match(dashboard, /liveActivityMount=/)
  const codexPortalIndex = taskConversation.indexOf(
    "createPortal(codexActivityPanel, props.liveActivityMount)"
  )
  const agentPortalIndex = taskConversation.indexOf(
    "createPortal(agentLiveActivityPanel, props.liveActivityMount)"
  )

  assert.notEqual(codexPortalIndex, -1)
  assert.notEqual(agentPortalIndex, -1)
  assert.ok(codexPortalIndex < agentPortalIndex)
  assert.match(taskConversation, /agentLiveResponseDetails/)
  assert.match(globalsCss, /.taskNavigation \.liveActivityMount \{[\s\S]*display: grid/)
})

test("rename action opens a visible native dialog for the title input", () => {
  assert.match(taskConversation, /const renameDialogRef = useRef<HTMLDialogElement>\(null\)/)
  assert.match(taskConversation, /function openRenameDialog\(\) \{[\s\S]*dialog\.showModal\(\)/)
  assert.match(taskConversation, /onClick=\{openRenameDialog\}/)
  assert.match(taskConversation, /aria-labelledby="rename-conversation-title"/)
  assert.match(taskConversation, /id="rename-conversation-title"/)
  assert.match(taskConversation, /aria-label="Rename conversation form"/)
})

test("dashboard resets bound workspace selection when a new conversation starts", () => {
  assert.match(dashboard, /const \[conversationVersion, setConversationVersion\] = useState\(0\)/)
  assert.match(dashboard, /function handleNewConversation\(\)/)
  assert.match(dashboard, /setConversationEntries\(\[\]\)/)
  assert.match(dashboard, /setSelectedProjectId\(undefined\)/)
  assert.match(dashboard, /setSelectedRunId\(undefined\)/)
  assert.match(dashboard, /setConversationVersion\(\(current\) => current \+ 1\)/)
  assert.match(dashboard, /key=\{`\$\{selectedRun\?\.id \?\? "unbound"\}:\$\{conversationVersion\}`\}/)
  assert.match(dashboard, /onNewConversation=\{handleNewConversation\}/)
})

test("conversation header exposes the action layout styles without changing the wider layout system", () => {
  assert.match(taskConversation, /<div style=\{\{ display: "grid", gap: "0\.25rem", flex: "1 1 14rem", minWidth: 0 \}\}>/)
  assert.match(taskConversation, /<h2 style=\{\{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" \}\}>/)
  assert.match(taskConversation, /<div className="taskConversationHeaderActions" style=\{\{ flex: "1 1 18rem", minWidth: 0, justifyContent: "flex-end" \}\}>/)
  assert.doesNotMatch(taskConversation, /className="compactPanelButton"[^>\n]*style=\{\{[^}]*width:/)
  assert.match(globalsCss, /\.taskConversationHeaderActions/)
  assert.match(globalsCss, /\.taskConversationHeaderActions\s*\{[\s\S]*display:\s*flex/)
  assert.match(globalsCss, /\.taskConversationHeaderActions\s*\{[\s\S]*flex-wrap:\s*wrap/)
})
