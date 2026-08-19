import { createAgentCardRouteHandlers } from "@/lib/a2a-route-handlers"

export const dynamic = "force-dynamic"

const handlers = createAgentCardRouteHandlers()

export const GET = handlers.GET

export { createAgentCardRouteHandlers }
