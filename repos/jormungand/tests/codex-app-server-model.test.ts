import assert from "node:assert/strict"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

async function loadModelHelpers() {
  const dynamicImport = new Function(
    "modulePath",
    "return import(modulePath)"
  ) as (modulePath: string) => Promise<{
    buildCodexAppServerArgs: (modelId?: string) => string[]
  }>
  return await dynamicImport(
    pathToFileURL(resolve("scripts/codex-models.mjs")).href
  )
}

test("app-server receives the provider matching the configured model", async () => {
  const { buildCodexAppServerArgs } = await loadModelHelpers()

  assert.deepEqual(buildCodexAppServerArgs("gpt-5.6-luna"), [
    "app-server",
    "--stdio",
    "-c",
    "model=gpt-5.6-luna",
    "-c",
    "model_provider=openai"
  ])
  assert.deepEqual(buildCodexAppServerArgs("MiniMax-M3"), [
    "app-server",
    "--stdio",
    "-c",
    "model=MiniMax-M3",
    "-c",
    "model_provider=minimax"
  ])
  assert.deepEqual(buildCodexAppServerArgs("gpt-5.6-sol"), [
    "app-server",
    "--stdio",
    "-c",
    "model=gpt-5.6-sol",
    "-c",
    "model_provider=openai"
  ])
})
