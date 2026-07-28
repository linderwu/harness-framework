import { promises as fs } from "fs"
import path from "path"
import type { HarnessState, Project, WorkflowRun } from "@/lib/types"
import { normalizeAgentKind } from "@/lib/agents"
import { createDefaultEventSkills, getDefaultSkillExecutor } from "@/lib/workflow"
import { normalizeWorkspace, refreshProjectAfterRun } from "@/lib/workspace"

const statePath = path.join(process.cwd(), "data", "harness-state.json")
let stateWriteQueue = Promise.resolve()

export class StateConflictError extends Error {
  latestRun?: WorkflowRun

  constructor(message: string, latestRun?: WorkflowRun) {
    super(message)
    this.name = "StateConflictError"
    this.latestRun = latestRun
  }
}

async function ensureStateFile() {
  await fs.mkdir(path.dirname(statePath), { recursive: true })

  try {
    await fs.access(statePath)
  } catch {
    await fs.writeFile(
      statePath,
      JSON.stringify(
        { schemaVersion: 3, projects: [], workflowRuns: [] } satisfies HarnessState,
        null,
        2
      )
    )
  }
}

export async function readState(): Promise<HarnessState> {
  await ensureStateFile()
  const raw = await fs.readFile(statePath, "utf8")
  const state = JSON.parse(raw) as Partial<HarnessState>
  return normalizeWorkspace({
    ...state,
    workflowRuns: (state.workflowRuns ?? []).map(normalizeWorkflowRun)
  })
}

export async function writeState(state: HarnessState) {
  await ensureStateFile()
  await fs.writeFile(statePath, JSON.stringify(state, null, 2))
}

export async function listProjects() {
  const state = await readState()
  return state.projects
}

export async function getProject(id: string) {
  const state = await readState()
  return state.projects.find((project) => project.id === id)
}

export async function upsertProject(nextProject: Project) {
  return withStateWrite(async () => {
    const state = await readState()
    const index = state.projects.findIndex((project) => project.id === nextProject.id)

    if (index >= 0) {
      state.projects[index] = nextProject
    } else {
      state.projects.push(nextProject)
    }

    const normalized = normalizeWorkspace(state)
    await writeState(normalized)
    return normalized.projects.find((project) => project.id === nextProject.id) ?? nextProject
  })
}

export async function listWorkflowRuns() {
  const state = await readState()
  return state.workflowRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getWorkflowRun(id: string) {
  const state = await readState()
  return state.workflowRuns.find((run) => run.id === id)
}

export async function upsertWorkflowRun(
  nextRun: WorkflowRun,
  options: { expectedVersion?: number } = {}
) {
  return withStateWrite(async () => {
    const state = await readState()
    const index = state.workflowRuns.findIndex((run) => run.id === nextRun.id)

    if (index >= 0) {
      const latestRun = normalizeWorkflowRun(state.workflowRuns[index])

      if (
        options.expectedVersion !== undefined &&
        latestRun.version !== options.expectedVersion
      ) {
        throw new StateConflictError(
          "Workflow run changed while this request was in progress.",
          latestRun
        )
      }

      state.workflowRuns[index] = normalizeWorkflowRun({
        ...nextRun,
        version: latestRun.version + 1
      })
    } else {
      if (options.expectedVersion !== undefined) {
        throw new StateConflictError(
          "Workflow run was deleted while this request was in progress."
        )
      }

      state.workflowRuns.push(
        normalizeWorkflowRun({
          ...nextRun,
          version: nextRun.version ?? 1
        })
      )
    }

    const linkedRun = state.workflowRuns.find((run) => run.id === nextRun.id)
    const linkedProjectIndex = linkedRun
      ? state.projects.findIndex((project) => project.id === linkedRun.projectId)
      : -1

    if (linkedRun && linkedProjectIndex >= 0) {
      state.projects[linkedProjectIndex] = refreshProjectAfterRun(
        state.projects[linkedProjectIndex],
        state.workflowRuns
      )
    }

    const normalizedState = normalizeWorkspace(state)
    await writeState(normalizedState)
    return normalizedState.workflowRuns.find((run) => run.id === nextRun.id) ?? nextRun
  })
}

export async function deleteWorkflowRun(id: string) {
  return withStateWrite(async () => {
    const state = await readState()
    const nextRuns = state.workflowRuns.filter((run) => run.id !== id)

    if (nextRuns.length === state.workflowRuns.length) {
      return false
    }

    await writeState(normalizeWorkspace({ ...state, workflowRuns: nextRuns }))
    return true
  })
}

function normalizeWorkflowRun(run: WorkflowRun): WorkflowRun {
  const eventSkills = run.eventSkills ?? createDefaultEventSkills()
  const selectedAgent = normalizeAgentKind(run.selectedAgent)
  const skillAssignments = Object.fromEntries(
    eventSkills.map((skill) => [
      skill.id,
      normalizeAgentKind(
        run.skillAssignments?.[skill.id] ??
          getDefaultSkillExecutor(skill.id, selectedAgent)
      )
    ])
  )

  const normalizedRun: WorkflowRun = {
    ...run,
    schemaVersion: run.schemaVersion ?? 2,
    version: run.version ?? 1,
    selectedAgent,
    eventSkills,
    skillAssignments,
    approvalPolicies: (run.approvalPolicies ?? []).map((policy) => ({
      ...policy,
      agent: policy.agent ? normalizeAgentKind(policy.agent) : undefined
    })),
    approvalGates: (run.approvalGates ?? []).map((gate) => ({
      ...gate,
      assignedAgent: gate.assignedAgent
        ? normalizeAgentKind(gate.assignedAgent)
        : undefined
    })),
    agentRuns: (run.agentRuns ?? []).map((agentRun) => ({
      ...agentRun,
      agent: normalizeAgentKind(agentRun.agent)
    })),
    artifacts: run.artifacts ?? [],
    events: run.events ?? [],
    revisions: run.revisions ?? [],
    eventLogStatus: run.eventLogStatus ?? "consistent"
  }

  return refreshEventLogStatus(normalizedRun)
}

function refreshEventLogStatus(run: WorkflowRun): WorkflowRun {
  const artifactIds = new Set(run.artifacts.map((artifact) => artifact.id))
  const missingOutputIds = run.events
    .flatMap((event) => event.outputArtifactIds)
    .filter((artifactId) => !artifactIds.has(artifactId))
  const wrongRunEvents = run.events.filter(
    (event) => event.workflowRunId !== run.id
  )

  if (missingOutputIds.length > 0 || wrongRunEvents.length > 0) {
    return {
      ...run,
      eventLogStatus: "drift_detected",
      eventLogWarning: [
        missingOutputIds.length > 0
          ? `${missingOutputIds.length} event output reference(s) point at missing artifacts`
          : undefined,
        wrongRunEvents.length > 0
          ? `${wrongRunEvents.length} event(s) belong to a different workflow run`
          : undefined
      ]
        .filter(Boolean)
        .join("; ")
    }
  }

  return {
    ...run,
    eventLogStatus: "consistent",
    eventLogWarning: undefined
  }
}

function withStateWrite<T>(operation: () => Promise<T>) {
  const nextOperation = stateWriteQueue.then(operation, operation)
  stateWriteQueue = nextOperation.then(
    () => undefined,
    () => undefined
  )
  return nextOperation
}
