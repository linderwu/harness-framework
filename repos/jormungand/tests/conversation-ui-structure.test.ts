import { readFileSync } from "node:fs"
import { strict as assert } from "node:assert"
import { test } from "node:test"

const taskConversation = readFileSync("components/task-conversation.tsx", "utf8")
const dashboard = readFileSync("components/harness-dashboard.tsx", "utf8")
const globalsCss = readFileSync("app/globals.css", "utf8")

test("task conversation keeps an active conversation id and sends it with unbound requests", () => {
  assert.match(taskConversation, /const \[conversationId, setConversationId\] = useState\(/)
  assert.match(taskConversation, /setConversationId\(data\.conversationId/)
  assert.match(taskConversation, /workflowRunId: activeConversationId/)
  assert.match(taskConversation, /body: JSON\.stringify\(\{ conversationId: activeConversationId, targetAgent, content: message, idempotencyKey \}\)/)
  assert.match(taskConversation, /body: JSON\.stringify\(\{ action, conversationId: activeConversationId \}\)/)
})

test("task conversation exposes a new conversation action with pending reset behavior", () => {
  assert.match(taskConversation, /New conversation/)
  assert.match(taskConversation, /const \[isStartingConversation, setIsStartingConversation\] = useState\(false\)/)
  assert.match(taskConversation, /fetch\("\/api\/conversation\/new", \{/)
  assert.match(taskConversation, /setEntries\(\[\]\)/)
  assert.match(taskConversation, /setSession\(undefined\)/)
  assert.match(taskConversation, /setEvents\(\[\]\)/)
  assert.match(taskConversation, /props\.onNewConversation\?\.\(/)
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
  assert.match(globalsCss, /\.taskConversationHeaderActions/)
  assert.match(globalsCss, /\.taskConversationHeaderActions\s*\{[\s\S]*display:\s*flex/)
  assert.match(globalsCss, /\.taskConversationHeaderActions\s*\{[\s\S]*flex-wrap:\s*wrap/)
})
