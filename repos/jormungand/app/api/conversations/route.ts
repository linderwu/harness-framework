import { NextResponse } from "next/server"
import {
  ConversationManagementError,
  createConversationManagementService
} from "@/lib/conversation-management"
import {
  stopCodexConversationSession
} from "@/lib/codex-conversation"
import {
  setConversationCookie
} from "@/lib/conversation-identity"
import { getDefaultHiveServices } from "@/lib/hive-services"

export async function GET(request: Request) {
  try {
    const includeArchived =
      new URL(request.url).searchParams.get("includeArchived") === "true"
    const service = getConversationManagementService()
    return NextResponse.json({
      conversations: service.listConversations({ includeArchived })
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function POST(request?: Request) {
  try {
    const body = await request?.json().catch(() => ({})) as { title?: unknown } | undefined
    const service = getConversationManagementService()
    const metadata = await service.createConversation({ title: body?.title })
    const response = NextResponse.json(
      {
        conversationId: metadata.conversationId,
        metadata
      },
      { status: 201 }
    )
    return setConversationCookie(response, metadata.conversationId, request)
  } catch (error) {
    return toErrorResponse(error)
  }
}

function getConversationManagementService() {
  const services = getDefaultHiveServices()
  return createConversationManagementService({
    repository: services.repository,
    stopSession: (conversationId) =>
      stopCodexConversationSession(services.repository, conversationId)
  })
}

function toErrorResponse(error: unknown) {
  if (error instanceof ConversationManagementError) {
    return NextResponse.json({ error: error.message }, { status: error.status })
  }

  return NextResponse.json(
    { error: error instanceof Error ? error.message : String(error) },
    { status: 500 }
  )
}
