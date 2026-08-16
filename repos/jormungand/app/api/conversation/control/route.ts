import { NextResponse } from "next/server"
import {
  CodexConversationError,
  controlCodexConversation
} from "@/lib/codex-conversation"
import { getDefaultHiveServices } from "@/lib/hive-services"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    action?: "interrupt" | "resume" | "stop"
  }

  if (!body.action || !["interrupt", "resume", "stop"].includes(body.action)) {
    return NextResponse.json(
      { error: "action must be interrupt, resume, or stop" },
      { status: 400 }
    )
  }

  try {
    const services = getDefaultHiveServices()
    return NextResponse.json(
      await controlCodexConversation(services.repository, body.action)
    )
  } catch (error) {
    if (error instanceof CodexConversationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
