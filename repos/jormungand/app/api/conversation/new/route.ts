import { createConversationResponse } from "../../conversations/route"

export async function POST(request?: Request) {
  return await createConversationResponse(request)
}
