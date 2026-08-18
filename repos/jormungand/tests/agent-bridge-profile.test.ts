import assert from "node:assert/strict"
import test, { TestContext } from "node:test"
import { createWorkflowRun } from "../lib/workflow"
import type { AgentKind, WorkflowEventSkill } from "../lib/types"

interface AgentBridgePayload {
  selectedModelId?: string
  selectedReasoningIntensity?: "low" | "medium" | "high" | "auto"
  workflowRunId?: string
  permissionMode?: "full" | "restricted"
}

function restoreEnv(t: TestContext, key: string) {
  const previousValue = process.env[key]
  t.after(() => {
    if (previousValue === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = previousValue
    }
  })
}

function installFetchMock(
  t: TestContext,
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = handler
  t.after(() => {
    globalThis.fetch = originalFetch
  })
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  })
}

test("Codex bridge receives workflow run model and reasoning intensity", async (t) => {
  restoreEnv(t, "CODEX_BRIDGE_URL")
  restoreEnv(t, "JORMUNGAND_AGENT_PERMISSION_MODE")
  process.env.CODEX_BRIDGE_URL = "http://codex.test"
  process.env.JORMUNGAND_AGENT_PERMISSION_MODE = " restricted "

  let capturedPayload: AgentBridgePayload = {}

  installFetchMock(t, async (input, init) => {
    assert.equal(String(input), "http://codex.test/agent-runs")
    const payload = JSON.parse(String(init?.body ?? "{}")) as AgentBridgePayload

    capturedPayload = {
      workflowRunId: payload.workflowRunId,
      permissionMode: payload.permissionMode,
      selectedModelId: payload.selectedModelId,
      selectedReasoningIntensity: payload.selectedReasoningIntensity
    }

    return jsonResponse({
      id: `bridge-run-${capturedPayload.workflowRunId}`,
      status: "completed",
      output: "Codex bridge completed."
    })
  })

  const { invokeConfiguredAgent } = await import("../lib/agent-bridge") as typeof import("../lib/agent-bridge")
  const run = createWorkflowRun({
    projectId: "project-1",
    projectName: "Codex profile test",
    repository: "owner/repo",
    requirement: "Validate codex profile forwarding.",
    selectedAgent: "codex" as AgentKind,
    selectedModelId: "gpt-4.1",
    selectedReasoningIntensity: "high",
    designApprovalActor: "independent_agent",
    verificationApprovalActor: "verification_subagent"
  })
  const skill = {
    id: "agent_task.response",
    eventType: "requirement_intake",
    stage: "intake",
    name: "Profile test",
    purpose: "Ensure payload carries codex profile.",
    trigger: "Profile test trigger",
    allowedActors: ["codex"],
    inputs: ["test input"],
    outputs: ["test output"],
    constraints: [],
    gates: [],
    knowledgeSources: [],
    verificationRules: []
  } satisfies WorkflowEventSkill

  const result = await invokeConfiguredAgent({
    run,
    executor: "codex",
    stage: "implementation",
    artifactType: "log",
    title: "Profile test",
    fallbackBody: "Fallback profile test",
    skill
  })

  assert.equal(result.status, "completed")
  assert.equal(capturedPayload.permissionMode, "restricted")
  assert.equal(capturedPayload.selectedModelId, "gpt-4.1")
  assert.equal(capturedPayload.selectedReasoningIntensity, "high")
  assert.equal(typeof capturedPayload.workflowRunId, "string")
})
