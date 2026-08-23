import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import { createPermissionModeText } from "../lib/context-builder"

const codexBridgeSource = readFileSync("scripts/codex-bridge.mjs", "utf8")
const codexAppServerSessionSource = readFileSync("scripts/codex-app-server-session.mjs", "utf8")
const agentBridgeSource = readFileSync("lib/agent-bridge.ts", "utf8")
const hiveServicesSource = readFileSync("lib/hive-services.ts", "utf8")
const openClawBridgeSource = readFileSync(
  "scripts/openclaw-bridge.mjs",
  "utf8"
)
const agentPermissionsSource = readFileSync(
  "scripts/agent-permissions.mjs",
  "utf8"
)
const openClawDeploySource = readFileSync(
  "scripts/deploy-openclaw-bridge.ps1",
  "utf8"
)
const proxySource = readFileSync("proxy.ts", "utf8")
const healthSource = readFileSync("app/health/route.ts", "utf8")

function loadNormalizePermissionMode(source: string) {
  const match = source.match(
    /function normalizePermissionMode\(value\) \{[\s\S]*?\n\}/
  )

  assert.ok(match, "normalizePermissionMode function must exist")

  return new Function(`${match[0]}; return normalizePermissionMode;`)() as (
    value?: unknown
  ) => "full" | "restricted"
}

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

test("unbound conversation source contracts direct agent execution", () => {
  assert.match(hiveServicesSource, /routeUnboundConversation/)
  assert.match(hiveServicesSource, /id: "conversation\.direct_execution"/)
  assert.match(
    hiveServicesSource,
    /directly without requiring project or workflow binding/
  )
  assert.match(
    hiveServicesSource,
    /Server authentication and bridge authorization remain required/
  )
  assert.doesNotMatch(hiveServicesSource, /conversation\.unbound_limited/)
  assert.doesNotMatch(hiveServicesSource, /Recent conversation:/)
})

test("permission mode text returns runtime full and restricted prompt wording", () => {
  const restricted = createPermissionModeText("restricted")
  const full = createPermissionModeText("full")

  assert.match(
    restricted.operatorScopeLine,
    /current sandbox and approval policy/
  )
  assert.match(
    restricted.workflowAuthorityConstraint,
    /current Codex sandbox, approval policy, and Jormungand workflow authority/
  )
  assert.match(
    full.operatorScopeLine,
    /operator-approved workspace and workflow scope/
  )
  assert.match(
    full.workflowAuthorityConstraint,
    /keep Jormungand in control of project binding and workflow authority/
  )
  assert.match(
    full.conversationConstraint,
    /Use full permissions only inside the operator-approved workspace and the active workflow scope/
  )
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
  assert.match(codexBridgeSource, /operator-approved workspace and workflow scope/)
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
  const normalizePermissionMode = loadNormalizePermissionMode(
    agentPermissionsSource
  )

  assert.equal(normalizePermissionMode(" restricted "), "restricted")
  assert.equal(normalizePermissionMode("RESTRICTED"), "restricted")
  assert.equal(normalizePermissionMode(" FULL "), "full")
  assert.match(
    codexBridgeSource,
    /import \{ normalizePermissionMode \} from "\.\/agent-permissions\.mjs"/
  )
  assert.match(
    codexBridgeSource,
    /const permissionMode = normalizePermissionMode\(\s*process\.env\.JORMUNGAND_AGENT_PERMISSION_MODE\s*\)/
  )
  assert.match(
    codexBridgeSource,
    /codex-app-server-session\.mjs/
  )
  assert.match(codexAppServerSessionSource, /danger-full-access/)
  assert.match(codexAppServerSessionSource, /dangerFullAccess/)
  assert.match(codexAppServerSessionSource, /approvalPolicy:\s*"never"/)
  assert.match(agentBridgeSource, /permissionMode/)
  assert.match(codexAppServerSessionSource, /workspace-write/)
  assert.match(codexAppServerSessionSource, /writableRoots:\s*\[input\.workspacePath\]/)
  assert.match(codexAppServerSessionSource, /networkAccess:\s*false/)
})

test("OpenClaw bridge accepts the compatibility token and enforces its local skill lock", () => {
  const normalizePermissionMode = loadNormalizePermissionMode(
    agentPermissionsSource
  )

  assert.equal(normalizePermissionMode(" restricted "), "restricted")
  assert.equal(normalizePermissionMode("RESTRICTED"), "restricted")
  assert.equal(normalizePermissionMode(" FULL "), "full")
  assert.match(
    openClawBridgeSource,
    /import \{ normalizePermissionMode \} from "\.\/agent-permissions\.mjs"/
  )
  assert.match(openClawBridgeSource, /from "\.\/openclaw-session\.mjs"/)
  assert.match(openClawBridgeSource, /OPENCLAW_GATEWAY_TOKEN/)
  assert.match(openClawBridgeSource, /OPENCLAW_RUNTIME_SKILL_LOCK/)
  assert.match(openClawBridgeSource, /bundle_not_locked/)
  assert.match(
    openClawBridgeSource,
    /const permissionMode = normalizePermissionMode\(payload\.permissionMode\)/
  )
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
