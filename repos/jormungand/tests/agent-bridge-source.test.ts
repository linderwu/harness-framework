import { readFileSync } from "node:fs"
import { test } from "node:test"
import { strict as assert } from "node:assert"

const bridge = readFileSync("lib/agent-bridge.ts", "utf8")
const openClawBridge = readFileSync("scripts/openclaw-bridge.mjs", "utf8")
const codexBridge = readFileSync("scripts/codex-bridge.mjs", "utf8")

test("OpenClaw A2A control sends a standalone slash stop message", () => {
  assert.match(bridge, /sendOpenClawA2AControl/)
  assert.match(bridge, /OPENCLAW_A2A_CONTROL_MESSAGE/)
  assert.match(bridge, /"\/stop"/)
  assert.match(bridge, /OPENCLAW_A2A_SESSION_KEY/)
  assert.match(bridge, /OPENCLAW_A2A_AGENT/)
})

test("OpenClaw A2A session keys use the shared bounded session helper", () => {
  assert.match(bridge, /openclaw-session\.mjs/)
  assert.doesNotMatch(bridge, /function sanitizeSessionSegment/)
})

test("OpenClaw HTTP bridge supports idempotency recovery polling", () => {
  assert.match(openClawBridge, /by-idempotency/)
  assert.match(openClawBridge, /completedIdempotencyRuns/)
  assert.match(openClawBridge, /idempotency-recovery/)
  assert.match(openClawBridge, /OPENCLAW_BRIDGE_COMPLETED_RUN_TTL_MS/)
  assert.match(openClawBridge, /pruneCompletedRuns/)
  assert.match(openClawBridge, /scheduleCompletedRunCleanup/)
  assert.match(openClawBridge, /completedRunCleanupTimer\.unref\?\.\(\)/)
})

test("OpenClaw HTTP bridge source exposes safe live-event replay markers", () => {
  assert.match(openClawBridge, /\/agent-runs\/by-idempotency\/:key\/events\//)
  assert.match(openClawBridge, /live-events/)
  assert.match(openClawBridge, /appendRunEvent/)
  assert.match(openClawBridge, /reasoning_content/)
  assert.match(openClawBridge, /<think>/)
  assert.doesNotMatch(openClawBridge, /stderrParser/)
})

test("OpenClaw HTTP bridge source bounds auxiliary live parsing state", () => {
  assert.match(openClawBridge, /appendTailText/)
  assert.match(openClawBridge, /appendBoundedRecord/)
  assert.match(openClawBridge, /appendBoundedFragment/)
  assert.match(openClawBridge, /maxParserBufferText/)
})

test("Codex quota reader accepts primary rate limits first, fallback to secondary", () => {
  assert.match(codexBridge, /const rateLimit = result\?\.rateLimits\?\.primary/)
  assert.match(codexBridge, /result\?\.rateLimits\?\.secondary/)
  assert.match(codexBridge, /if \(!rateLimit\)/)
  assert.match(codexBridge, /account\/rateLimits\/read/)
})
