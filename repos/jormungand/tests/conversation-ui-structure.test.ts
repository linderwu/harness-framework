import { readFileSync } from "node:fs"
import { strict as assert } from "node:assert"
import { test } from "node:test"

const taskConversation = readFileSync("components/task-conversation.tsx", "utf8")
const dashboard = readFileSync("components/harness-dashboard.tsx", "utf8")
const globalsCss = readFileSync("app/globals.css", "utf8")

test("task conversation keeps an active conversation id and sends it with unbound requests", () => {
  assert.match(taskConversation, /const \[conversationId, setConversationId\] = useState<string \| undefined>\(runId\)/)
  assert.doesNotMatch(taskConversation, /const defaultConversationId = runId \?\? "global:unbound-conversation"/)
  assert.match(taskConversation, /setConversationId\(data\.conversationId/)
  assert.match(taskConversation, /const activeConversationId = isUnbound \? conversationId : runId/)
  assert.match(taskConversation, /workflowRunId: activeConversationId/)
  assert.match(taskConversation, /body: JSON\.stringify\(\{ conversationId: activeConversationId, targetAgent, content: message, idempotencyKey \}\)/)
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
  assert.match(taskConversation, /disabled=\{!content\.trim\(\) \|\| !allowedAgents\.length \|\| !activeConversationId \|\| isTurnRunning \|\| isLoadingConversation \|\| isStartingConversation \|\| !!activeManagerAction\}/)
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
