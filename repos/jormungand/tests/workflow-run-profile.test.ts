import assert from "node:assert/strict"
import test from "node:test"
import { createWorkflowRun } from "../lib/workflow"
import type { WorkflowRun } from "../lib/types"

type WorkflowRunProfileRoute = {
  PATCH: (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>
}

type WorkflowRunProfileRouteModule = {
  createWorkflowRunRouteHandlers?: (dependencies: {
    getWorkflowRun: (id: string) => Promise<WorkflowRun | undefined>
    upsertWorkflowRun: (run: WorkflowRun, options?: { expectedVersion?: number }) => Promise<WorkflowRun>
  }) => WorkflowRunProfileRoute
}

async function loadRouteModule() {
  return await import("../app/api/workflow-runs/[id]/route") as WorkflowRunProfileRouteModule
}

test("workflow run profile PATCH persists selected model and reasoning intensity", async () => {
  const routeModule = await loadRouteModule()
  assert.equal(typeof routeModule.createWorkflowRunRouteHandlers, "function")

  const run = createWorkflowRun({
    projectId: "project-profile",
    projectName: "Profile project",
    projectType: "agent_task",
    repository: "",
    requirement: "Persist profile changes.",
    selectedAgent: "codex",
    selectedModelId: "gpt-5.6-sol",
    selectedReasoningIntensity: "low",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
  let savedRun: WorkflowRun | undefined
  let expectedVersion: number | undefined
  const handlers = routeModule.createWorkflowRunRouteHandlers!({
    getWorkflowRun: async (id) => id === run.id ? run : undefined,
    upsertWorkflowRun: async (nextRun, options) => {
      savedRun = nextRun
      expectedVersion = options?.expectedVersion
      return nextRun
    }
  })

  const response = await handlers.PATCH(
    new Request(`http://localhost/api/workflow-runs/${run.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        selectedModelId: "gpt-5.6-luna",
        selectedReasoningIntensity: "high"
      })
    }),
    { params: Promise.resolve({ id: run.id }) }
  )

  assert.equal(response.status, 200)
  assert.equal(savedRun?.selectedModelId, "gpt-5.6-luna")
  assert.equal(savedRun?.selectedReasoningIntensity, "high")
  assert.equal(expectedVersion, run.version)
})
test("workflow run profile PATCH rejects unsupported reasoning intensity with a client error", async () => {
  const routeModule = await loadRouteModule()
  const run = createWorkflowRun({
    projectId: "project-profile-invalid",
    projectName: "Invalid profile project",
    projectType: "agent_task",
    repository: "",
    requirement: "Reject invalid profile values.",
    selectedAgent: "codex",
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
  const handlers = routeModule.createWorkflowRunRouteHandlers!({
    getWorkflowRun: async (id) => id === run.id ? run : undefined,
    upsertWorkflowRun: async (nextRun) => nextRun
  })

  const response = await handlers.PATCH(
    new Request(`http://localhost/api/workflow-runs/${run.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ selectedReasoningIntensity: "extreme" })
    }),
    { params: Promise.resolve({ id: run.id }) }
  )

  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /selectedReasoningIntensity/)
})
