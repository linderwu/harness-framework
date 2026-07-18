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

  const advancedRun = await advanceWorkflow(run, {
    invokeAgent: invokeConfiguredAgent
  })
  const latestRun = await getWorkflowRun(id)

  if (!latestRun) {
    return NextResponse.json({ deleted: true, id })
  }

  if (latestRun?.status === "cancelled") {
    return NextResponse.json(latestRun)
  }

  const nextRun = await upsertWorkflowRun(advancedRun)
  return NextResponse.json(nextRun)
}
