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
import { getDefaultHiveServices } from "@/lib/hive-services"

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
      if (run.managed) {
        const { scheduler } = getDefaultHiveServices()
        await scheduler.enqueue({
          workflowRunId: run.id,
          reason: "health_check",
          idempotencyKey: `advance:${run.id}:${run.version}`
        })
        await scheduler.runNext(run.id)
        const refreshedRun = await getWorkflowRun(run.id)
        return NextResponse.json(refreshedRun ?? run)
      }

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
