import { NextResponse } from "next/server"
import { getDefaultHiveServices } from "@/lib/hive-services"

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params
  try {
    return NextResponse.json(await getDefaultHiveServices().scheduler.pause(id, "human"))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return NextResponse.json({ error: message }, { status: /not found/i.test(message) ? 404 : 409 })
  }
}
