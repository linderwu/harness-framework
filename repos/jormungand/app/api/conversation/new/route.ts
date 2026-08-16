import { NextResponse } from "next/server"
import {
  createConversationId,
  setConversationCookie
} from "@/lib/conversation-identity"

export async function POST(_request?: Request) {
  const conversationId = createConversationId()
  return setConversationCookie(
    NextResponse.json({ conversationId }),
    conversationId,
    _request
  )
}
