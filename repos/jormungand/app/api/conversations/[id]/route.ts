import { NextResponse } from "next/server"
import {
  ConversationManagementError,
  createConversationManagementService
} from "@/lib/conversation-management"
import {
  deleteCodexConversationThread,
  renameCodexConversationThread,
  setCodexConversationThreadState,
  stopCodexConversationSession
} from "@/lib/codex-conversation"
import { getDefaultHiveServices } from "@/lib/hive-services"

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const body = await request.json().catch(() => undefined) as
      | { title?: unknown; state?: unknown; selectedModelId?: unknown }
      | undefined

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ConversationManagementError("Request body must be a JSON object.", 400)
    }

    const service = getConversationManagementService()
    return NextResponse.json(
      await service.updateConversation({
        conversationId: id,
        title: body.title,
        state: body.state,
        selectedModelId: body.selectedModelId
      })
    )
  } catch (error) {
    return toErrorResponse(error)
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const body = await request.json().catch(() => undefined) as
      | { confirm?: unknown }
      | undefined

    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ConversationManagementError("Request body must be a JSON object.", 400)
    }

    const service = getConversationManagementService()
    await service.deleteConversation({
      conversationId: id,
      confirm: body.confirm
    })
    return new NextResponse(null, { status: 204 })
  } catch (error) {
    return toErrorResponse(error)
  }
}

function getConversationManagementService() {
  const services = getDefaultHiveServices()
  return createConversationManagementService({
    repository: services.repository,
    stopSession: (conversationId) =>
      stopCodexConversationSession(services.repository, conversationId),
    renameNativeThread: (conversationId, title) =>
      renameCodexConversationThread(services.repository, conversationId, `Harness · ${title}`),
    setNativeThreadState: (conversationId, state) =>
      setCodexConversationThreadState(services.repository, conversationId, state),
    deleteNativeThread: (conversationId) =>
      deleteCodexConversationThread(services.repository, conversationId),
    cancelQueuedMessages: (conversationId) =>
      services.conversationQueue.cancelPending(conversationId)
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
