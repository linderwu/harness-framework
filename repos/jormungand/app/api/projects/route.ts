import { NextResponse } from "next/server"
import { createProject } from "@/lib/workspace"
import { listProjects, upsertProject } from "@/lib/store"
import type { ProjectContextFile, ProjectType } from "@/lib/types"

export async function GET() {
  return NextResponse.json(await listProjects())
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string
    type?: ProjectType
    goal?: string
    repository?: string
    sourceRef?: string
    contextFiles?: ProjectContextFile[]
  }

  if (!body.name || !body.goal || !body.type) {
    return NextResponse.json(
      { error: "name, type, and goal are required" },
      { status: 400 }
    )
  }

  const project = createProject({
    name: body.name,
    type: body.type,
    goal: body.goal,
    repository: body.repository ?? "",
    source: "dashboard",
    sourceRef: body.sourceRef,
    contextFiles: Array.isArray(body.contextFiles) ? body.contextFiles : []
  })

  return NextResponse.json(await upsertProject(project), { status: 201 })
}
