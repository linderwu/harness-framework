import { readFileSync } from "node:fs"
import { test } from "node:test"
import { strict as assert } from "node:assert"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

const dashboard = readFileSync("components/harness-dashboard.tsx", "utf8")
const bridge = readFileSync("scripts/codex-bridge.mjs", "utf8")
const modelsRoute = readFileSync("app/api/codex-models/route.ts", "utf8")

async function loadModelHelpers() {
  const dynamicImport = new Function(
    "modulePath",
    "return import(modulePath)"
  ) as (modulePath: string) => Promise<{
    buildCodexExecModelArgs: (modelId?: string, reasoningIntensity?: string) => string[]
    normalizeCodexModels: (result: unknown) => Array<{
      id: string
      displayName: string
      isDefault: boolean
    }>
    defaultCodexModelId: (models: Array<{ id: string; isDefault: boolean }>) =>
      | string
      | undefined
  }>
  return await dynamicImport(
    pathToFileURL(resolve("scripts/codex-models.mjs")).href
  )
}

test("dashboard loads the live Codex model catalog instead of stale hard-coded ids", () => {
  assert.match(dashboard, /api\/codex-models/)
  assert.doesNotMatch(dashboard, /"gpt-5-mini"/)
  assert.doesNotMatch(dashboard, /"gpt-4\.1"/)
  assert.doesNotMatch(dashboard, /"o3-mini"/)
})

test("Codex bridge exposes the live model catalog and passes the selected model to exec", () => {
  assert.match(bridge, /model\/list/)
  assert.match(bridge, /\/models/)
  assert.match(bridge, /selectedModelId/)
  assert.match(bridge, /buildCodexExecModelArgs/)
  assert.match(modelsRoute, /CODEX_BRIDGE_URL/)
  assert.match(modelsRoute, /Authorization/)
})

test("model catalog keeps visible live models and chooses the server default", async () => {
  const { buildCodexExecModelArgs, defaultCodexModelId, normalizeCodexModels } =
    await loadModelHelpers()
  const models = normalizeCodexModels({
    data: [
      { id: "hidden", model: "hidden", hidden: true },
      { model: "gpt-5.6-sol", displayName: "GPT-5.6-Sol", isDefault: true },
      { model: "gpt-5.6-sol", displayName: "duplicate" },
      { model: "gpt-5.6-luna", displayName: "GPT-5.6-Luna" }
    ]
  })

  assert.deepEqual(
    models.map((model) => model.id),
    ["gpt-5.6-sol", "gpt-5.6-luna"]
  )
  assert.equal(defaultCodexModelId(models), "gpt-5.6-sol")
  assert.deepEqual(buildCodexExecModelArgs("gpt-5.6-sol", "high"), [
    "--model",
    "gpt-5.6-sol",
    "-c",
    'model_provider="openai"',
    "-c",
    'model_reasoning_effort="high"'
  ])
  assert.deepEqual(buildCodexExecModelArgs("MiniMax-M3", "high"), [
    "--model",
    "MiniMax-M3",
    "-c",
    'model_provider="minimax"',
    "-c",
    'model_reasoning_effort="high"'
  ])
  assert.deepEqual(buildCodexExecModelArgs("custom-model", "high"), [
    "--model",
    "custom-model",
    "-c",
    'model_reasoning_effort="high"'
  ])
  assert.deepEqual(buildCodexExecModelArgs("ChatGPT OAuth", "auto"), [])
})
