import { NextResponse } from "next/server"
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

  const nextRun = await upsertWorkflowRun(advanceWorkflow(run))
  return NextResponse.json(nextRun)
}
