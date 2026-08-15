import { NextResponse } from "next/server"
import { getDefaultHiveServices } from "@/lib/hive-services"
import { getWorkflowRun } from "@/lib/store"

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const run = await getWorkflowRun(id)
  if (!run) return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
  if (!run.managed) return NextResponse.json({ error: "Workflow run is not manager-controlled" }, { status: 409 })
  const body = (await request.json()) as { content?: string; idempotencyKey?: string }
  if (!body.content?.trim() || !body.idempotencyKey?.trim()) {
    return NextResponse.json({ error: "content and idempotencyKey are required" }, { status: 400 })
  }
  const { repository, scheduler } = getDefaultHiveServices()
  await repository.appendEvent({
    eventType: "manager_operator_message", actor: "human", workflowRunId: id,
    payload: { content: body.content.trim() }, idempotencyKey: body.idempotencyKey
  })
  await scheduler.enqueue({ workflowRunId: id, reason: "operator_message", idempotencyKey: `wake:${body.idempotencyKey}` })
  void scheduler.runNext(id)
  return NextResponse.json({ status: "queued" }, { status: 202 })
}
