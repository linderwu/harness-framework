import { NextResponse } from "next/server"
import { ConversationError } from "@/lib/conversation"
import {
  ConversationIdentityError,
  resolveConversationId,
  setConversationCookie
} from "@/lib/conversation-identity"
import {
  getCodexConversationState
} from "@/lib/codex-conversation"
import { getAgentPermissionMode } from "@/lib/agent-permissions"
import { getDefaultHiveServices } from "@/lib/hive-services"
import { agentProfiles } from "@/lib/agents"
import type { AgentKind } from "@/lib/types"

// postCodexConversationMessage remains available as a migration helper; new requests use the durable queue below.

export async function GET(request?: Request) {
  const requestedConversationId = request ? new URL(request.url).searchParams.get("conversationId") : undefined
  const identity = resolveConversationId({
    request,
    bodyConversationId: requestedConversationId ?? undefined,
    fallbackToNew: true,
    legacyMode: "rotate"
  })
  const services = getDefaultHiveServices()
  void services.conversationDispatcher.drain(identity.conversationId).catch(() => undefined)
  const metadata = identity.conversationId.startsWith("conversation:")
    ? services.repository.getConversationMetadata(identity.conversationId)
      ?? await services.repository.createConversation({
        id: identity.conversationId,
        title: "New conversation"
      })
    : services.repository.getConversationMetadata(identity.conversationId)
  const codexState = await getCodexConversationState(
    services.repository,
    identity.conversationId
  )
  const unboundConversation = await services.conversation.getUnboundConversation(
    identity.conversationId
  )
  const response = NextResponse.json({
    ...codexState,
    entries: unboundConversation.entries,
    allowedAgents: unboundConversation.allowedAgents,
    binding: unboundConversation.binding,
    permissionMode: getAgentPermissionMode(),
    metadata: unboundConversation.metadata ?? metadata
  })
  return identity.shouldSetCookie
    ? setConversationCookie(response, identity.conversationId, request)
    : response
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    conversationId?: unknown
    content?: string
    idempotencyKey?: string
    targetAgent?: string
    selectedModelId?: unknown
    selectedReasoningIntensity?: unknown
  }
  if (!body.content?.trim() || !body.idempotencyKey?.trim()) {
    return NextResponse.json({ error: "content and idempotencyKey are required" }, { status: 400 })
  }
  if (body.targetAgent && !agentProfiles.some((agent) => agent.id === body.targetAgent)) {
    return NextResponse.json({ error: "targetAgent is invalid" }, { status: 403 })
  }
  try {
    const identity = resolveConversationId({
      request,
      bodyConversationId: body.conversationId,
      fallbackToNew: true,
      legacyMode: "rotate",
      legacyBodyMode: "reject"
    })
    const services = getDefaultHiveServices()
    const result = await services.conversation.enqueueUnboundMessage({
      conversationId: identity.conversationId,
      content: body.content,
      targetAgent: body.targetAgent as AgentKind | undefined,
      idempotencyKey: body.idempotencyKey,
      selectedModelId: body.selectedModelId,
      selectedReasoningIntensity: body.selectedReasoningIntensity
    })
    void services.conversationDispatcher.drain(identity.conversationId).catch(() => undefined)
    const response = NextResponse.json(result, {
      status: result.duplicate ? 200 : 202
    })
    return identity.shouldSetCookie
      ? setConversationCookie(response, identity.conversationId, request)
      : response
  } catch (error) {
    if (error instanceof ConversationIdentityError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    if (error instanceof ConversationError) {
      return NextResponse.json({ error: error.message }, { status: error.status })
    }
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 500 })
  }
}
