import assert from "node:assert/strict"
import { test } from "node:test"
import { pathToFileURL } from "node:url"
import { resolve } from "node:path"

async function loadModelHelpers() {
  const dynamicImport = new Function(
    "modulePath",
    "return import(modulePath)"
  ) as (modulePath: string) => Promise<{
    buildCodexAppServerArgs: (modelId?: string, options?: Record<string, unknown>) => string[]
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


test("DSH Codex sessions can inject the agent delegation MCP server", async () => {
  const { buildCodexAppServerArgs } = await loadModelHelpers()

  assert.deepEqual(buildCodexAppServerArgs(undefined, {
    dshAgentDelegation: {
      command: "node",
      args: ["C:/bridge/agent-call-mcp.mjs", "--parent-session-id", "session-1"],
      envVars: ["CODEX_BRIDGE_TOKEN", "PI_WORKSPACE_ID"],
      startupTimeoutSec: 10,
      toolTimeoutSec: 120,
    },
  }), [
    "app-server",
    "--stdio",
    "-c",
    "mcp_servers.dsh_agent_bridge.command='node'",
    "-c",
    "mcp_servers.dsh_agent_bridge.args=['C:/bridge/agent-call-mcp.mjs','--parent-session-id','session-1']",
    "-c",
    "mcp_servers.dsh_agent_bridge.env_vars=['CODEX_BRIDGE_TOKEN','PI_WORKSPACE_ID']",
    "-c",
    "mcp_servers.dsh_agent_bridge.startup_timeout_sec=10",
    "-c",
    "mcp_servers.dsh_agent_bridge.tool_timeout_sec=120",
  ])
})
