import { NextResponse } from "next/server"
import {
  readState,
  StateConflictError,
  upsertWorkflowRun,
  withWorkflowRunLock
} from "@/lib/store"
import { decideApprovalGate } from "@/lib/workflow"
import { getDefaultHiveServices } from "@/lib/hive-services"

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

  return withWorkflowRunLock(run.id, async () => {
    const latestRun = await getRunForGate(id)

    if (!latestRun) {
      return NextResponse.json({ error: "Approval gate not found" }, { status: 404 })
    }

    try {
      const nextRun = await upsertWorkflowRun(
        decideApprovalGate(latestRun, id, body.decision!, body.note),
        { expectedVersion: latestRun.version }
      )
      if (nextRun.managed) {
        const { scheduler } = getDefaultHiveServices()
        const decidedGate = nextRun.approvalGates.find((gate) => gate.id === id)
        await scheduler.enqueue({
          workflowRunId: nextRun.id,
          reason: "approval_decided",
          idempotencyKey: `approval:${id}:${body.decision}:${decidedGate?.decidedAt ?? nextRun.updatedAt}`
        })
        void scheduler.runNext(nextRun.id)
      }
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

async function getRunForGate(gateId: string) {
  const state = await readState()
  return state.workflowRuns.find((item) =>
    item.approvalGates.some((gate) => gate.id === gateId)
  )
}
