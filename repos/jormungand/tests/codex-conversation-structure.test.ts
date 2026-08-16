import { readFileSync } from "node:fs"
import { test } from "node:test"
import { strict as assert } from "node:assert"

const conversation = readFileSync("lib/codex-conversation.ts", "utf8")
const route = readFileSync("app/api/conversation/route.ts", "utf8")
const controlRoute = readFileSync("app/api/conversation/control/route.ts", "utf8")
const component = readFileSync("components/task-conversation.tsx", "utf8")
const bridge = readFileSync("scripts/codex-bridge.mjs", "utf8")

test("Codex conversation persists an unbound session and idempotent entries", () => {
  assert.match(conversation, /global:unbound-conversation/)
  assert.match(conversation, /getCodexSession\(/)
  assert.match(conversation, /upsertCodexSession\(/)
  assert.match(conversation, /getConversationByIdempotencyKey\(/)
  assert.match(conversation, /events\?after=/)
})

test("Codex conversation exposes live controls and converges final text", () => {
  assert.match(conversation, /finalText/)
  assert.match(conversation, /turnStatus === "completed"/)
  assert.match(conversation, /action: "interrupt" \| "resume" \| "stop"/)
  assert.match(route, /postCodexConversationMessage/)
  assert.match(controlRoute, /controlCodexConversation/)
  assert.match(controlRoute, /interrupt, resume, or stop/)
})

test("browser conversation renders Codex activity and polls while pending", () => {
  assert.match(component, /aria-label="Codex activity"/)
  assert.match(component, />Pause<|>Continue<|>Stop</)
  assert.match(component, /isUnbound \? 1_200 : 3_000/)
  assert.match(component, /liveAssistantText/)
  assert.match(component, /Codex is working/)
})

test("browser conversation polling does not overlap requests", () => {
  assert.match(component, /const pollingInFlight = useRef/)
  assert.match(component, /if \(pollingInFlight\.current\) return/)
  assert.match(component, /pollingInFlight\.current = request/)
  assert.match(component, /pollingInFlight\.current === request\).*pollingInFlight\.current = undefined/)
})

test("unbound conversation exposes the registered OpenClaw agents", () => {
  assert.match(route, /getUnboundConversation\(/)
  assert.match(route, /allowedAgents: unboundConversation\.allowedAgents/)
  assert.match(component, /const initialAllowedAgents = props\.allowedAgents/)
  assert.match(component, /targetAgent === "codex"/)
})

test("Codex bridge exposes session events and pause controls", () => {
  assert.match(bridge, /\/sessions/)
  assert.match(bridge, /thread\/start/)
  assert.match(bridge, /turn\/interrupt/)
  assert.match(bridge, /turn_paused/)
  assert.match(bridge, /codex-session-events/)
})
