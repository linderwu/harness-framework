import { NextResponse } from "next/server"
import { readState, upsertWorkflowRun } from "@/lib/store"
import { decideApprovalGate } from "@/lib/workflow"

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const { id } = await context.params
  const body = (await request.json()) as {
    decision?: "approved" | "rejected" | "changes_requested"
    note?: string
  }

  if (!body.decision) {
    return NextResponse.json({ error: "decision is required" }, { status: 400 })
  }

  const state = await readState()
  const run = state.workflowRuns.find((item) =>
    item.approvalGates.some((gate) => gate.id === id)
  )

  if (!run) {
    return NextResponse.json({ error: "Approval gate not found" }, { status: 404 })
  }

  const nextRun = await upsertWorkflowRun(
    decideApprovalGate(run, id, body.decision, body.note)
  )

  return NextResponse.json(nextRun)
}
