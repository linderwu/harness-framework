import { createA2ATaskRouteHandlers } from "@/lib/a2a-route-handlers"

export const dynamic = "force-dynamic"

const handlers = createA2ATaskRouteHandlers()

export const GET = handlers.GET
export const POST = handlers.POST

export { createA2ATaskRouteHandlers }
