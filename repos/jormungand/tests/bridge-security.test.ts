import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const codexBridgeSource = readFileSync("scripts/codex-bridge.mjs", "utf8")
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

test("OpenClaw bridge accepts the compatibility token and enforces its local skill lock", () => {
  assert.match(openClawBridgeSource, /OPENCLAW_GATEWAY_TOKEN/)
  assert.match(openClawBridgeSource, /OPENCLAW_RUNTIME_SKILL_LOCK/)
  assert.match(openClawBridgeSource, /bundle_not_locked/)
  assert.doesNotMatch(openClawBridgeSource, /SITE_AUTH_PASSWORD/)
})

test("OpenClaw deployment pins SSH hosts and deploys the skill lock", () => {
  assert.match(openClawDeploySource, /StrictHostKeyChecking=yes/)
  assert.match(openClawDeploySource, /\.ssh\\known_hosts/)
  assert.match(openClawDeploySource, /skill\.lock\.json/)
  assert.doesNotMatch(openClawDeploySource, /StrictHostKeyChecking=accept-new/)
  assert.doesNotMatch(openClawDeploySource, /SITE_AUTH_PASSWORD/)
  assert.doesNotMatch(openClawDeploySource, /127\.0\.0\.1:4188/)
})

test("site health stays public while application routes remain protected", () => {
  assert.match(proxySource, /favicon\.ico\|health\$/)
  assert.match(healthSource, /ok: true/)
  assert.match(healthSource, /service: "jormungandr"/)
})
