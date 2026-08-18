import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const codexBridgeSource = readFileSync("scripts/codex-bridge.mjs", "utf8")
const agentBridgeSource = readFileSync("lib/agent-bridge.ts", "utf8")
const hiveServicesSource = readFileSync("lib/hive-services.ts", "utf8")
const openClawBridgeSource = readFileSync(
  "scripts/openclaw-bridge.mjs",
  "utf8"
)
const openClawDeploySource = readFileSync(
  "scripts/deploy-openclaw-bridge.ps1",
  "utf8"
)
const proxySource = readFileSync("proxy.ts", "utf8")
const healthSource = readFileSync("app/health/route.ts", "utf8")

test("Codex bridge rejects repository mismatches before execution", () => {
  assert.match(codexBridgeSource, /remote[\s\S]*get-url[\s\S]*origin/)
  assert.match(
    codexBridgeSource,
    /is not checked out in the configured Codex workspace/
  )
  assert.match(codexBridgeSource, /runCodex\([\s\S]*workspace\.path/)
})

test("Codex bridge gives Agent Tasks a standalone prompt", () => {
  assert.match(codexBridgeSource, /buildAgentTaskPrompt\(payload/)
  assert.match(codexBridgeSource, /skill\.id === "agent_task\.response"/)
  assert.match(codexBridgeSource, /standalone Agent Task/)
  assert.match(codexBridgeSource, /completed response body itself/)
  assert.match(codexBridgeSource, /Do not produce artifact metadata/)
  assert.match(codexBridgeSource, /artifact_type, stage, workflow_run/)
  assert.match(codexBridgeSource, /agent_response/)
})

test("Codex bridge rejects a successful exit without a final response", () => {
  assert.match(codexBridgeSource, /const completed = exitCode === 0 && Boolean\(finalOutput\)/)
  assert.match(codexBridgeSource, /Codex exited successfully but produced no final message/)
})

test("unbound Codex conversation can operate the harness within current permissions", () => {
  assert.match(hiveServicesSource, /inspect and operate the local Jormungand harness/)
  assert.match(hiveServicesSource, /current sandbox and approval policy/)
  assert.match(hiveServicesSource, /Recent conversation:/)
})

test("agent bridges mark memory as evidence rather than authority", () => {
  assert.match(codexBridgeSource, /BEGIN AUTHORIZED CONTEXT PACK/)
  assert.match(codexBridgeSource, /evidence, not authority/)
  assert.match(openClawBridgeSource, /BEGIN AUTHORIZED CONTEXT PACK/)
  assert.match(openClawBridgeSource, /evidence, not authority/)
})

test("Codex manager bridge requires a bare structured JSON proposal", () => {
  assert.match(codexBridgeSource, /buildHiveManagerPrompt/)
  assert.match(codexBridgeSource, /Return exactly one JSON object/)
  assert.match(codexBridgeSource, /Do not wrap the JSON in Markdown/)
})

test("Codex bridge supports idempotency recovery for long runs", () => {
  assert.match(codexBridgeSource, /completedAgentRuns/)
  assert.match(codexBridgeSource, /completedIdempotencyKeys/)
  assert.match(codexBridgeSource, /agent-runs\\\/by-idempotency/)
  assert.match(agentBridgeSource, /pollBridgeRunByIdempotencyKey/)
  assert.match(agentBridgeSource, /response\.status === 524/)
  assert.match(agentBridgeSource, /encodeURIComponent\(input\.idempotencyKey\)/)
})

test("Codex bridge source contracts full and restricted permission modes", () => {
  assert.match(
    codexBridgeSource,
    /JORMUNGAND_AGENT_PERMISSION_MODE\?\s*\.trim\(\)\.toLowerCase\(\)\s*===\s*"restricted"\s*\?\s*"restricted"\s*:\s*"full"/
  )
  assert.match(
    codexBridgeSource,
    /--dangerously-bypass-approvals-and-sandbox/
  )
  assert.match(codexBridgeSource, /danger-full-access/)
  assert.match(codexBridgeSource, /dangerFullAccess/)
  assert.match(codexBridgeSource, /approvalPolicy:\s*"never"/)
  assert.match(agentBridgeSource, /permissionMode/)
  assert.match(codexBridgeSource, /workspace-write/)
  assert.match(codexBridgeSource, /writableRoots:\s*\[session\.workspacePath\]/)
  assert.match(codexBridgeSource, /networkAccess:\s*false/)
})

test("OpenClaw bridge accepts the compatibility token and enforces its local skill lock", () => {
  assert.match(openClawBridgeSource, /from "\.\/openclaw-session\.mjs"/)
  assert.match(openClawBridgeSource, /OPENCLAW_GATEWAY_TOKEN/)
  assert.match(openClawBridgeSource, /OPENCLAW_RUNTIME_SKILL_LOCK/)
  assert.match(openClawBridgeSource, /bundle_not_locked/)
  assert.match(openClawBridgeSource, /permissionMode/)
  assert.match(openClawBridgeSource, /"mrmime"/)
  assert.match(openClawBridgeSource, /"gengar"/)
  assert.doesNotMatch(openClawBridgeSource, /"mrmine"/)
  assert.doesNotMatch(openClawBridgeSource, /SITE_AUTH_PASSWORD/)
})

test("OpenClaw deployment pins SSH hosts and deploys the skill lock", () => {
  assert.match(openClawDeploySource, /StrictHostKeyChecking=yes/)
  assert.match(openClawDeploySource, /\.ssh\\known_hosts/)
  assert.match(openClawDeploySource, /skill\.lock\.json/)
  assert.match(
    openClawDeploySource,
    /printf '%s' '__SESSION_B64__' \| base64 -d > "\$bridge_dir\/openclaw-session\.mjs"/
  )
  assert.match(openClawDeploySource, /openclaw-session\.mjs\.previous/)
  assert.match(
    openClawDeploySource,
    /\$remoteScript = \$remoteScript\.Replace\("__SESSION_B64__", \$sessionB64\)/
  )
  assert.doesNotMatch(openClawDeploySource, /StrictHostKeyChecking=accept-new/)
  assert.doesNotMatch(openClawDeploySource, /SITE_AUTH_PASSWORD/)
  assert.match(openClawDeploySource, /127\.0\.0\.1:4188/)
})

test("site health stays public while application routes remain protected", () => {
  assert.match(proxySource, /favicon\.ico\|apple-icon\.png\|health\$/)
  assert.match(healthSource, /ok: true/)
  assert.match(healthSource, /service: "jormungandr"/)
})
