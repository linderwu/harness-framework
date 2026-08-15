import { NextResponse } from "next/server"
import { agentProfiles } from "@/lib/agents"
import { ConversationError } from "@/lib/conversation"
import { getDefaultHiveServices } from "@/lib/hive-services"
import type { AgentKind } from "@/lib/types"

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  try {
    return NextResponse.json(await getDefaultHiveServices().conversation.getConversation(id))
  } catch (error) {
    return conversationErrorResponse(error)
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  const body = (await request.json().catch(() => ({}))) as {
    targetAgent?: string
    content?: string
    replyToId?: string
    idempotencyKey?: string
  }
  if (!body.content?.trim() || !body.idempotencyKey?.trim()) {
    return NextResponse.json({ error: "content and idempotencyKey are required" }, { status: 400 })
  }
  if (!agentProfiles.some((profile) => profile.id === body.targetAgent)) {
    return NextResponse.json({ error: "targetAgent is invalid" }, { status: 403 })
  }
  try {
    const result = await getDefaultHiveServices().conversation.postMessage({
      workflowRunId: id,
      targetAgent: body.targetAgent as AgentKind,
      content: body.content,
      replyToId: body.replyToId,
      idempotencyKey: body.idempotencyKey
    })
    return NextResponse.json(result, { status: result.duplicate ? 200 : 202 })
  } catch (error) {
    return conversationErrorResponse(error)
  }
}

function conversationErrorResponse(error: unknown) {
  if (error instanceof ConversationError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }
  return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
}
