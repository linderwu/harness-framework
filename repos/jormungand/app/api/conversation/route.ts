import { NextResponse } from "next/server"
import { ConversationError } from "@/lib/conversation"
import { getDefaultHiveServices } from "@/lib/hive-services"
import { agentProfiles } from "@/lib/agents"
import type { AgentKind } from "@/lib/types"

export async function GET() {
  return NextResponse.json(await getDefaultHiveServices().conversation.getUnboundConversation())
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    content?: string
    idempotencyKey?: string
    targetAgent?: string
  }
  if (!body.content?.trim() || !body.idempotencyKey?.trim()) {
    return NextResponse.json({ error: "content and idempotencyKey are required" }, { status: 400 })
  }
  if (body.targetAgent && !agentProfiles.some((agent) => agent.id === body.targetAgent)) {
    return NextResponse.json({ error: "targetAgent is invalid" }, { status: 403 })
  }
  try {
    const result = await getDefaultHiveServices().conversation.postUnboundMessage({
      content: body.content,
      targetAgent: body.targetAgent as AgentKind | undefined,
      idempotencyKey: body.idempotencyKey
    })
    return NextResponse.json(result, { status: result.duplicate ? 200 : 202 })
  } catch (error) {
    if (error instanceof ConversationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
