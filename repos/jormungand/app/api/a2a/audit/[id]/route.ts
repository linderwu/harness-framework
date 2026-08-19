import { createA2AAuditRouteHandlers } from "@/lib/a2a-route-handlers"

export const dynamic = "force-dynamic"

const handlers = createA2AAuditRouteHandlers()

export const GET = handlers.GET

export { createA2AAuditRouteHandlers }
