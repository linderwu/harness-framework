import { NextResponse } from "next/server"
import { invokeConfiguredAgent } from "@/lib/agent-bridge"
import { getWorkflowRun, upsertWorkflowRun } from "@/lib/store"
import { advanceWorkflow } from "@/lib/workflow"

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const run = await getWorkflowRun(id)

  if (!run) {
    return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
  }

  const nextRun = await upsertWorkflowRun(
    await advanceWorkflow(run, { invokeAgent: invokeConfiguredAgent })
  )
  return NextResponse.json(nextRun)
}
