import { NextResponse } from "next/server"
import { ConversationError } from "@/lib/conversation"
import { getDefaultHiveServices } from "@/lib/hive-services"

export async function GET() {
  return NextResponse.json(getDefaultHiveServices().conversation.getUnboundConversation())
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    content?: string
    idempotencyKey?: string
  }
  if (!body.content?.trim() || !body.idempotencyKey?.trim()) {
    return NextResponse.json({ error: "content and idempotencyKey are required" }, { status: 400 })
  }
  try {
    const result = await getDefaultHiveServices().conversation.postUnboundMessage({
      content: body.content,
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
