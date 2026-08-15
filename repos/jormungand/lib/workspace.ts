import { getProjectTemplate } from "./project-templates"
import type {
  HarnessState,
  Project,
  ProjectContextFile,
  ProjectOverview,
  ProjectStatus,
  ProjectType,
  WorkspaceWarning,
  WorkflowRun,
  ManagedProjectConfig
} from "./types"

const workspaceSchemaVersion = 3

export interface CreateProjectInput {
  name: string
  type: ProjectType
  goal: string
  repository: string
  source: Project["source"]
  sourceRef?: string
  contextFiles?: ProjectContextFile[]
  managedConfig?: ManagedProjectConfig
}

export function createProject(input: CreateProjectInput): Project {
  const template = getProjectTemplate(input.type)
  const now = new Date().toISOString()

  return {
    id: crypto.randomUUID(),
    name: input.name.trim(),
    type: template.type,
    goal: input.goal.trim(),
    status: "active",
    currentPhase: template.phases[0],
    nextAction: template.defaultNextAction,
    repository: input.repository.trim(),
    source: input.source,
    sourceRef: input.sourceRef,
    contextFiles: input.contextFiles ?? [],
    managedConfig: input.managedConfig,
    artifactIds: [],
    workflowRunIds: [],
    createdAt: now,
    updatedAt: now
  }
}

export function normalizeWorkspace(state: Partial<HarnessState>): HarnessState {
  const warnings: WorkspaceWarning[] = [...(state.warnings ?? [])]
  const projects = [...(state.projects ?? [])]
  const workflowRuns = [...(state.workflowRuns ?? [])]
  const projectsById = new Map(projects.map((project) => [project.id, project]))

  const normalizedRuns = workflowRuns.map((run) => {
    if (run.projectId && projectsById.has(run.projectId)) {
      return run
    }

    const project = createLegacyProject(run)
    projects.push(project)
    projectsById.set(project.id, project)
    warnings.push({
      code: run.projectId ? "missing_project_for_run" : "legacy_project_created",
      message: run.projectId
        ? `Workflow run "${run.id}" referenced a missing project and was moved into a legacy development project.`
        : `Workflow run "${run.id}" was moved into a legacy development project.`,
      projectId: project.id,
      workflowRunId: run.id
    })

    return { ...run, projectId: project.id }
  })

  const refreshedProjects = projects.map((project) =>
    refreshProjectLinks(project, normalizedRuns, warnings)
  )

  return {
    schemaVersion: workspaceSchemaVersion,
    projects: refreshedProjects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    workflowRuns: normalizedRuns.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    warnings
  }
}

export function getProjectOverview(project: Project, workflowRuns: WorkflowRun[]): ProjectOverview {
  const projectRuns = workflowRuns
    .filter((run) => run.projectId === project.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const template = getProjectTemplate(project.type)

  return {
    project,
    phaseLabels: template.phases,
    artifacts: projectRuns.flatMap((run) => run.artifacts),
    pendingGates: projectRuns.flatMap((run) => run.approvalGates.filter((gate) => gate.status === "pending")),
    agentRuns: projectRuns.flatMap((run) => run.agentRuns),
    workflowEvents: projectRuns.flatMap((run) => run.events),
    contextFiles: project.contextFiles,
    latestRun: projectRuns[0],
    warning: template.warning
  }
}

export function refreshProjectAfterRun(project: Project, workflowRuns: WorkflowRun[]): Project {
  return refreshProjectLinks(project, workflowRuns, [])
}

function createLegacyProject(run: WorkflowRun): Project {
  const now = run.updatedAt ?? new Date().toISOString()

  return {
    id: crypto.randomUUID(),
    name: run.projectName || "Legacy Workflow Run",
    type: "development",
    goal: run.requirement || "Continue legacy workflow run.",
    status: projectStatusFromRun(run.status),
    currentPhase: "Intake",
    nextAction: nextActionFromRun(run),
    repository: run.repository ?? "",
    source: run.source ?? "dashboard",
    sourceRef: run.sourceRef,
    contextFiles: run.contextFiles ?? [],
    managedConfig: run.managedConfig,
    artifactIds: run.artifacts.map((artifact) => artifact.id),
    workflowRunIds: [run.id],
    createdAt: run.createdAt ?? now,
    updatedAt: now
  }
}

function refreshProjectLinks(project: Project, workflowRuns: WorkflowRun[], warnings: WorkspaceWarning[]): Project {
  const projectRuns = workflowRuns.filter((run) => run.projectId === project.id)
  const artifactIds = unique(projectRuns.flatMap((run) => run.artifacts.map((artifact) => artifact.id)))
  const workflowRunIds = unique(projectRuns.map((run) => run.id))

  project.artifactIds
    .filter((artifactId) => !artifactIds.includes(artifactId))
    .forEach((artifactId) => {
      warnings.push({
        code: "missing_project_artifact_reference",
        message: `Project "${project.id}" referenced missing artifact "${artifactId}".`,
        projectId: project.id,
        artifactId
      })
    })

  const latestRun = [...projectRuns].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]

  return {
    ...project,
    status: latestRun ? projectStatusFromRun(latestRun.status) : project.status,
    currentPhase: latestRun ? phaseFromRun(project.type, latestRun) : project.currentPhase,
    nextAction: latestRun ? nextActionFromRun(latestRun) : project.nextAction,
    artifactIds,
    workflowRunIds,
    updatedAt: latestRun?.updatedAt ?? project.updatedAt
  }
}

function phaseFromRun(projectType: ProjectType, run: WorkflowRun) {
  const template = getProjectTemplate(projectType)

  if (run.currentStage === "completed") {
    return template.phases[template.phases.length - 1]
  }

  const stageIndex: Record<WorkflowRun["currentStage"], number> = {
    intake: 0,
    plan: 1,
    design: 2,
    implementation: 3,
    verification: 4,
    completed: 5
  }

  return template.phases[stageIndex[run.currentStage]] ?? template.phases[0]
}

function projectStatusFromRun(status: WorkflowRun["status"]): ProjectStatus {
  if (status === "waiting_for_approval") return "waiting_for_approval"
  if (status === "stopped" || status === "failed" || status === "cancelled" || status === "completed") return status
  return "active"
}

function nextActionFromRun(run: WorkflowRun) {
  if (run.status === "waiting_for_approval") return "Review the pending approval gate."
  if (run.status === "running") return "Wait for the active run step to finish."
  if (run.status === "completed") return "Review final artifacts."
  if (run.status === "failed") return "Inspect the failed run and decide the recovery path."
  if (run.status === "cancelled") return "Review preserved artifacts from the cancelled run."
  if (run.status === "stopped") return "Resume or revise the stopped stage."
  return "Advance the project run."
}

function unique(values: string[]) {
  return Array.from(new Set(values))
}
