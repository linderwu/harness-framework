import { NextResponse } from "next/server"
import { getAgentQuotas } from "@/lib/agent-quota-store"

export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json(await getAgentQuotas(), {
    headers: { "Cache-Control": "no-store" }
  })
}
