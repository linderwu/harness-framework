import { NextResponse } from "next/server"
import {
  ConversationIdentityError,
  resolveConversationId,
  setConversationCookie
} from "@/lib/conversation-identity"
import {
  CodexConversationError,
  controlCodexConversation
} from "@/lib/codex-conversation"
import { getDefaultHiveServices } from "@/lib/hive-services"

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    conversationId?: unknown
    action?: "interrupt" | "resume" | "stop"
  }

  if (!body.action || !["interrupt", "resume", "stop"].includes(body.action)) {
    return NextResponse.json(
      { error: "action must be interrupt, resume, or stop" },
      { status: 400 }
    )
  }

  try {
    const identity = resolveConversationId({
      request,
      bodyConversationId: body.conversationId,
      legacyMode: "reject",
      requireExplicit: true
    })
    const services = getDefaultHiveServices()
    if (body.action === "interrupt" || body.action === "stop") {
      await services.conversationLifecycle.cancelPendingTurns(identity.conversationId)
    }
    let control = await controlCodexConversation(
      services.repository,
      body.action,
      identity.conversationId
    )
    if (body.action === "stop") {
      await services.conversationLifecycle.stopTurn(identity.conversationId)
      control = { ...control, entries: services.repository.listConversation(identity.conversationId) }
    }
    const response = NextResponse.json(control)
    return identity.shouldSetCookie
      ? setConversationCookie(response, identity.conversationId, request)
      : response
  } catch (error) {
    if (error instanceof ConversationIdentityError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    if (error instanceof CodexConversationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
