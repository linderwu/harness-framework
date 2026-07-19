import { NextResponse } from "next/server"
import { cancelConfiguredAgentRun } from "@/lib/agent-bridge"
import { getWorkflowRun, StateConflictError, upsertWorkflowRun } from "@/lib/store"
import { cancelWorkflowRun } from "@/lib/workflow"

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const run = await getWorkflowRun(id)

  if (!run) {
    return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
  }

  try {
    const nextRun = await upsertWorkflowRun(cancelWorkflowRun(run), {
      expectedVersion: run.version
    })
    await cancelConfiguredAgentRun(run)
    return NextResponse.json(nextRun)
  } catch (error) {
    if (error instanceof StateConflictError) {
      return NextResponse.json(
        {
          error: error.message,
          latestRun: error.latestRun
        },
        { status: 409 }
      )
    }

    throw error
  }
}
