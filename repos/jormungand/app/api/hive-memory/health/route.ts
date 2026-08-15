import { NextResponse } from "next/server"
import { getHiveMemoryHealth } from "@/lib/hive-health"
import { getDefaultHiveServices } from "@/lib/hive-services"

export const dynamic = "force-dynamic"

export async function GET() {
  return NextResponse.json(await getHiveMemoryHealth(getDefaultHiveServices().database))
}
