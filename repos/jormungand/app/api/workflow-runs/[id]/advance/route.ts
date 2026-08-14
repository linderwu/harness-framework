import { NextResponse } from "next/server"
import { invokeConfiguredAgent } from "@/lib/agent-bridge"
import { createRuntimeSkillResolver } from "@/lib/runtime-skills"
import {
  getWorkflowRun,
  replaceWorkflowRunSnapshot,
  StateConflictError,
  upsertWorkflowRun,
  withWorkflowRunLock
} from "@/lib/store"
import { advanceWorkflow } from "@/lib/workflow"

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  return withWorkflowRunLock(id, async () => {
    const run = await getWorkflowRun(id)

    if (!run) {
      return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
    }

    try {
      const advancedRun = await advanceWorkflow(run, {
        invokeAgent: invokeConfiguredAgent,
        resolveRuntimeSkillBundles: createRuntimeSkillResolver(),
        onProgress: replaceWorkflowRunSnapshot
      })
      const nextRun = await upsertWorkflowRun(advancedRun, {
        expectedVersion: run.version
      })
      return NextResponse.json(nextRun)
    } catch (error) {
      if (error instanceof StateConflictError) {
        return NextResponse.json(
          { error: error.message, latestRun: error.latestRun },
          { status: 409 }
        )
      }

      throw error
    }
  })
}
