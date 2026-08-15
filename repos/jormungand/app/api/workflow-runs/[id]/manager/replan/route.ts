import { NextResponse } from "next/server"
import { getDefaultHiveServices } from "@/lib/hive-services"
import { getWorkflowRun, upsertWorkflowRun, withWorkflowRunLock } from "@/lib/store"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = (await request.json()) as {
    instruction?: string
    idempotencyKey?: string
    budgetReduction?: Partial<{ callLimit: number; timeLimitMs: number; costLimitUsd: number }>
  }
  if (!body.instruction?.trim() || !body.idempotencyKey?.trim()) {
    return NextResponse.json({ error: "instruction and idempotencyKey are required" }, { status: 400 })
  }
  const instruction = body.instruction.trim()
  const idempotencyKey = body.idempotencyKey.trim()
  return withWorkflowRunLock(id, async () => {
    const run = await getWorkflowRun(id)
    if (!run) return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
    if (!run.managed) return NextResponse.json({ error: "Workflow run is not manager-controlled" }, { status: 409 })
    const reduction = body.budgetReduction ?? {}
    const current = run.managed.budget
    if (
      (reduction.callLimit !== undefined && (reduction.callLimit > current.callLimit || reduction.callLimit < current.callsUsed)) ||
      (reduction.timeLimitMs !== undefined && reduction.timeLimitMs > current.timeLimitMs) ||
      (reduction.costLimitUsd !== undefined && (reduction.costLimitUsd > current.costLimitUsd || reduction.costLimitUsd < current.costUsedUsd))
    ) {
      return NextResponse.json({ error: "budgetReduction may only reduce remaining capacity" }, { status: 400 })
    }
    const next = await upsertWorkflowRun({
      ...run,
      managed: {
        ...run.managed,
        state: "idle",
        budget: {
          ...current,
          callLimit: reduction.callLimit ?? current.callLimit,
          timeLimitMs: reduction.timeLimitMs ?? current.timeLimitMs,
          costLimitUsd: reduction.costLimitUsd ?? current.costLimitUsd
        }
      },
      updatedAt: new Date().toISOString()
    }, { expectedVersion: run.version })
    const { repository, scheduler } = getDefaultHiveServices()
    await repository.appendEvent({
      eventType: "manager_replan_requested", actor: "human", workflowRunId: id,
      payload: { instruction, budgetReduction: reduction },
      idempotencyKey
    })
    await scheduler.enqueue({ workflowRunId: id, reason: "mission_amended", idempotencyKey: `wake:${idempotencyKey}` })
    void scheduler.runNext(id)
    return NextResponse.json(next)
  })
}
