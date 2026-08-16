import { readFileSync } from "node:fs"
import { strict as assert } from "node:assert"
import test from "node:test"

const conversationRoute = readFileSync("app/api/conversation/route.ts", "utf8")
const controlRoute = readFileSync("app/api/conversation/control/route.ts", "utf8")
const codexConversation = readFileSync("lib/codex-conversation.ts", "utf8")
const agentBridge = readFileSync("lib/agent-bridge.ts", "utf8")
const openClawBridge = readFileSync("scripts/openclaw-bridge.mjs", "utf8")
const taskConversation = readFileSync("components/task-conversation.tsx", "utf8")
const dashboard = readFileSync("components/harness-dashboard.tsx", "utf8")

test("conversation API returns a conversation id and supports a new conversation flow", () => {
  assert.match(conversationRoute, /conversationId/)
  assert.match(conversationRoute, /newConversation|startNewConversation/)
})

test("conversation UI renders a New conversation action and posts the active conversation id", () => {
  assert.match(taskConversation, /New conversation/)
  assert.match(taskConversation, /conversationId/)
  assert.match(taskConversation, /body:\s*JSON\.stringify\(\{\s*conversationId,\s*targetAgent,\s*content,\s*idempotencyKey\s*\}\)/s)
})

test("dashboard wires task conversation through explicit lifecycle state instead of one implicit global thread", () => {
  assert.match(dashboard, /conversationId/)
  assert.match(dashboard, /new conversation|startNewConversation/i)
})

test("Codex conversation state is keyed by conversation id instead of a fixed global identifier", () => {
  assert.match(codexConversation, /getCodexConversationState\(\s*repository:\s*HiveMemoryRepository,\s*conversationId:\s*string/s)
  assert.match(codexConversation, /postCodexConversationMessage\(input:\s*\{\s*repository:\s*HiveMemoryRepository,\s*conversationId:\s*string/s)
  assert.match(codexConversation, /controlCodexConversation\(\s*repository:\s*HiveMemoryRepository,\s*conversationId:\s*string,\s*action:/s)
  assert.doesNotMatch(codexConversation, /export const codexConversationId = "global:unbound-conversation"/)
})

test("Codex control API forwards conversation id instead of controlling only one fixed session", () => {
  assert.match(controlRoute, /conversationId/)
  assert.match(controlRoute, /controlCodexConversation\(services\.repository,\s*body\.conversationId,\s*body\.action\)/)
})

test("OpenClaw bridge accepts stable conversation identity or session key input from the harness", () => {
  assert.match(agentBridge, /conversationId/)
  assert.match(agentBridge, /sessionKey/)
  assert.match(openClawBridge, /payload\.conversationId|payload\.sessionKey/)
  assert.match(openClawBridge, /const sessionKey = .*conversation/i)
})
