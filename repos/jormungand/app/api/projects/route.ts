import { NextResponse } from "next/server"
import { createProject } from "@/lib/workspace"
import { listProjects, upsertProject } from "@/lib/store"
import { ensureGitHubRepository } from "@/lib/github-repository"
import type { ProjectContextFile, ProjectType } from "@/lib/types"
import {
  createArceusMaintenanceConfig,
  createHiveMissionConfig
} from "@/lib/managed-workflows"

export async function GET() {
  return NextResponse.json(await listProjects())
}

export async function POST(request: Request) {
  const body = (await request.json()) as {
    name?: string
    type?: ProjectType
    goal?: string
    repository?: string
    autoCreateRepository?: boolean
    sourceRef?: string
    contextFiles?: ProjectContextFile[]
    successCriteria?: string[]
    constraints?: string[]
    nonGoals?: string[]
    repositoryScope?: string
    budget?: { callLimit: number; timeLimitMs: number; costLimitUsd: number }
  }

  if (!body.name || !body.goal || !body.type) {
    return NextResponse.json(
      { error: "name, type, and goal are required" },
      { status: 400 }
    )
  }

  let managedConfig
  try {
    managedConfig = body.type === "hive_mission"
      ? createHiveMissionConfig({
          successCriteria: body.successCriteria ?? [],
          repositoryScope: body.repositoryScope ?? body.repository ?? "",
          constraints: body.constraints ?? [],
          nonGoals: body.nonGoals ?? [],
          budget: body.budget ?? { callLimit: 20, timeLimitMs: 3_600_000, costLimitUsd: 5 }
        })
      : body.type === "arceus_maintenance"
        ? createArceusMaintenanceConfig({
            repository: process.env.JORMUNGAND_REPOSITORY ?? "",
            successCriteria: body.successCriteria ?? [],
            constraints: body.constraints ?? [],
            nonGoals: body.nonGoals ?? []
          })
        : undefined
    if (body.type === "arceus_maintenance" && body.repository?.trim()) {
      return NextResponse.json({ error: "Arceus repository is fixed by JORMUNGAND_REPOSITORY" }, { status: 400 })
    }
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 })
  }

  const repository = await resolveOrCreateRepository({
    repository: body.repository ?? "",
    type: body.type,
    managedConfigKind: managedConfig?.kind,
    fallback: body.name,
    autoCreate: body.autoCreateRepository ?? false
  })

  const project = createProject({
    name: body.name,
    type: body.type,
    goal: body.goal,
    repository,
    source: "dashboard",
    sourceRef: body.sourceRef,
    contextFiles: Array.isArray(body.contextFiles) ? body.contextFiles : [],
    managedConfig
  })

  return NextResponse.json(await upsertProject(project), { status: 201 })
}

async function resolveOrCreateRepository(input: {
  repository: string
  type: ProjectType
  managedConfigKind?: "hive_mission" | "arceus_maintenance"
  fallback: string
  autoCreate: boolean
}) {
  if (
    input.type === "arceus_maintenance" ||
    input.managedConfigKind === "arceus_maintenance"
  ) {
    return input.repository
  }

  const explicit = input.repository.trim()
  if (explicit) {
    return ensureGitHubRepository(explicit)
  }

  if (input.type === "hive_mission" || input.managedConfigKind === "hive_mission") {
    return input.repository
  }

  if (!input.autoCreate) {
    return ""
  }

  return ensureGitHubRepository(normalizeRepositoryName(input.fallback))
}

function normalizeRepositoryName(input: string) {
  const normalized = input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "")
    .slice(0, 100)

  return normalized || `harness-${Date.now().toString(36)}`
}
