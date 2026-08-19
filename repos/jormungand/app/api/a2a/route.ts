import { createA2ARouteHandlers } from "@/lib/a2a-route-handlers"

export const dynamic = "force-dynamic"

const handlers = createA2ARouteHandlers()

export const POST = handlers.POST

export { createA2ARouteHandlers }
