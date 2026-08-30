import { NextResponse } from "next/server"
import {
  getWorkflowRun,
  StateConflictError,
  upsertWorkflowRun,
  withWorkflowRunLock
} from "@/lib/store"
import type { CodexReasoningIntensity, WorkflowRun } from "@/lib/types"

type WorkflowRunRouteDependencies = {
  getWorkflowRun?: (id: string) => Promise<WorkflowRun | undefined>
  upsertWorkflowRun?: (
    run: WorkflowRun,
    options?: { expectedVersion?: number }
  ) => Promise<WorkflowRun>
}

export function createWorkflowRunRouteHandlers(
  dependencies: WorkflowRunRouteDependencies = {}
) {
  const readRun = dependencies.getWorkflowRun ?? getWorkflowRun
  const persistRun = dependencies.upsertWorkflowRun ?? upsertWorkflowRun

  return {
    GET: (request: Request, context: { params: Promise<{ id: string }> }) =>
      getWorkflowRunById(request, context, readRun),
    PATCH: (request: Request, context: { params: Promise<{ id: string }> }) =>
      patchWorkflowRunProfile(request, context, readRun, persistRun)
  }
}

export const { GET, PATCH } = createWorkflowRunRouteHandlers()

async function getWorkflowRunById(
  _request: Request,
  context: { params: Promise<{ id: string }> },
  readRun: (id: string) => Promise<WorkflowRun | undefined>
) {
  const { id } = await context.params
  const run = await readRun(id)

  if (!run) {
    return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
  }

  return NextResponse.json(run)
}

async function patchWorkflowRunProfile(
  request: Request,
  context: { params: Promise<{ id: string }> },
  readRun: (id: string) => Promise<WorkflowRun | undefined>,
  persistRun: (
    run: WorkflowRun,
    options?: { expectedVersion?: number }
  ) => Promise<WorkflowRun>
) {
  const { id } = await context.params
  const body = await request.json().catch(() => undefined) as
    | { selectedModelId?: unknown; selectedReasoningIntensity?: unknown }
    | undefined

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 })
  }

  const hasSelectedModelId = body.selectedModelId !== undefined
  const hasSelectedReasoningIntensity = body.selectedReasoningIntensity !== undefined
  if (!hasSelectedModelId && !hasSelectedReasoningIntensity) {
    return NextResponse.json(
      { error: "Provide selectedModelId or selectedReasoningIntensity." },
      { status: 400 }
    )
  }

  return withWorkflowRunLock(id, async () => {
    const run = await readRun(id)
    if (!run) {
      return NextResponse.json({ error: "Workflow run not found" }, { status: 404 })
    }

    let nextRun: WorkflowRun
    try {
      nextRun = {
        ...run,
        ...(hasSelectedModelId
          ? { selectedModelId: parseSelectedModelId(body.selectedModelId) }
          : {}),
        ...(hasSelectedReasoningIntensity
          ? { selectedReasoningIntensity: parseSelectedReasoningIntensity(body.selectedReasoningIntensity) }
          : {}),
        updatedAt: new Date().toISOString()
      }
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : String(error) },
        { status: 400 }
      )
    }

    try {
      return NextResponse.json(await persistRun(nextRun, { expectedVersion: run.version }))
    } catch (error) {
      if (error instanceof StateConflictError) {
        return NextResponse.json(
          { error: error.message, latestRun: error.latestRun },
          { status: 409 }
        )
      }
      throw error
    }
  })
}

function parseSelectedModelId(value: unknown): string | undefined {
  if (value === null) return undefined
  if (typeof value !== "string") {
    throw new Error("selectedModelId must be null or a string up to 120 characters.")
  }

  const normalized = value.trim()
  if (normalized.length > 120) {
    throw new Error("selectedModelId must be null or a string up to 120 characters.")
  }

  return normalized || undefined
}

function parseSelectedReasoningIntensity(
  value: unknown
): CodexReasoningIntensity | undefined {
  if (value === null) return undefined
  if (value !== "auto" && value !== "low" && value !== "medium" && value !== "high") {
    throw new Error(
      "selectedReasoningIntensity must be null, auto, low, medium, or high."
    )
  }

  return value
}
