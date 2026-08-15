import { NextResponse } from "next/server"
import { getDefaultHiveServices } from "@/lib/hive-services"
import type { ManagerWakeReason } from "@/lib/manager-scheduler"
import { getWorkflowRun } from "@/lib/store"

const wakeReasons: ManagerWakeReason[] = [
  "mission_created", "mission_amended", "worker_completed", "worker_failed",
  "worker_timed_out", "worker_unreachable", "review_blocked", "memory_candidate",
  "memory_conflict", "approval_decided", "health_check", "operator_message",
  "operator_resume"
]

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const run = await getWorkflowRun(id)
  if (!run) return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
  if (!run.managed) return NextResponse.json({ error: "Workflow run is not manager-controlled" }, { status: 409 })
  const body = (await request.json()) as { reason?: ManagerWakeReason; idempotencyKey?: string }
  if (!body.reason || !wakeReasons.includes(body.reason) || !body.idempotencyKey?.trim()) {
    return NextResponse.json({ error: "valid reason and idempotencyKey are required" }, { status: 400 })
  }
  const { scheduler } = getDefaultHiveServices()
  await scheduler.enqueue({ workflowRunId: id, reason: body.reason, idempotencyKey: body.idempotencyKey })
  void scheduler.runNext(id)
  return NextResponse.json({ status: "queued" }, { status: 202 })
}
