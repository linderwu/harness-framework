import { NextResponse } from "next/server"
import { getSuperpowersCatalog } from "@/lib/superpowers-catalog"

export async function GET() {
  try {
    const catalog = await getSuperpowersCatalog()
    return NextResponse.json({
      refreshedAt: new Date(catalog.refreshedAt).toISOString(),
      skills: catalog.skills.map(({ content: _content, ...skill }) => skill)
    })
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unable to load Superpowers skills." },
      { status: 503 }
    )
  }
}
