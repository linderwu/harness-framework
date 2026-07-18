import { NextResponse } from "next/server"
import { getWorkflowRun } from "@/lib/store"

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const run = await getWorkflowRun(id)

  if (!run) {
    return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
  }

  return NextResponse.json(run)
}
