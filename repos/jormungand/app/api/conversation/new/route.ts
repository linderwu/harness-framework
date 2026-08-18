import { NextResponse } from "next/server"
import {
  setConversationCookie
} from "@/lib/conversation-identity"
import {
  ConversationManagementError,
  createConversationManagementService
} from "@/lib/conversation-management"
import { stopCodexConversationSession } from "@/lib/codex-conversation"
import { getDefaultHiveServices } from "@/lib/hive-services"

export async function POST(request?: Request) {
  try {
    const services = getDefaultHiveServices()
    const service = createConversationManagementService({
      repository: services.repository,
      stopSession: (conversationId) =>
        stopCodexConversationSession(services.repository, conversationId)
    })
    const metadata = await service.createConversation()
    return setConversationCookie(
      NextResponse.json({ conversationId: metadata.conversationId }),
      metadata.conversationId,
      request
    )
  } catch (error) {
    if (error instanceof ConversationManagementError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }

    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    )
  }
}
