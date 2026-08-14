import { NextResponse } from "next/server"

export const dynamic = "force-dynamic"

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "jormungandr",
    endpoint: "agent-health",
    protectedAppRequiresBasicAuth: true,
    timestamp: new Date().toISOString()
  })
}
