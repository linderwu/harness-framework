import { handleCreateConversationRequest } from "../../conversations/route"

export async function POST(request?: Request) {
  return await handleCreateConversationRequest(request)
}
