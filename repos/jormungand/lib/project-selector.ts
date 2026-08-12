import { getProjectTemplate } from "./project-templates"
import type { Project, WorkflowRun, WorkflowStatus } from "./types"

export type ProjectSelectorFilter =
  | "all"
  | "active"
  | "needs_attention"
  | "completed"

export type ProjectSelectorStatusGroup =
  | "needs_attention"
  | "running"
  | "active"
  | "done"

export interface ProjectSelectorStatus {
  group: ProjectSelectorStatusGroup
  label: string
  dotVariant: ProjectSelectorStatusGroup
}

export interface ProjectSelectorItem {
  project: Project
  projectTypeLabel: string
  projectRuns: WorkflowRun[]
  latestRun?: WorkflowRun
  latestRunSummary: string
  activityAt?: string
  activityTime: number
  relativeActivityLabel: string
  absoluteActivityLabel: string
  status: ProjectSelectorStatus
}

export function buildProjectSelectorItems(
  projects: Project[],
  runs: WorkflowRun[],
  now = new Date()
) {
  return projects
    .map((project) => {
      const projectRuns = runs
        .filter((run) => run.projectId === project.id)
        .sort((a, b) => compareActivityDescending(a.updatedAt, b.updatedAt))
      const latestRun = projectRuns[0]
      const activityAt = latestRun?.updatedAt ?? project.updatedAt
      const activityTime = parseActivityTime(activityAt)
      const projectTypeLabel = getProjectTemplate(project.type).label

      return {
        project,
        projectRuns,
        latestRun,
        projectTypeLabel,
        activityAt,
        activityTime,
        relativeActivityLabel: formatRelativeActivityTime(activityAt, now),
        absoluteActivityLabel: formatAbsoluteActivityTime(activityAt),
        latestRunSummary: latestRun
          ? `Latest run: ${latestRun.status} - ${stageDisplay(latestRun.currentStage)}`
          : "No runs yet",
        status: getProjectCompositeStatus(project, projectRuns)
      } satisfies ProjectSelectorItem
    })
    .sort((a, b) => b.activityTime - a.activityTime)
}

export function filterProjectSelectorItems(
  items: ProjectSelectorItem[],
  query: string,
  filter: ProjectSelectorFilter
) {
  const normalizedQuery = query.trim().toLowerCase()

  return items.filter((item) => {
    const matchesFilter =
      filter === "all" ||
      (filter === "needs_attention" &&
        item.status.group === "needs_attention") ||
      (filter === "active" &&
        (item.status.group === "running" || item.status.group === "active")) ||
      (filter === "completed" && item.status.group === "done")

    if (!matchesFilter) {
      return false
    }

    if (normalizedQuery.length === 0) {
      return true
    }

    return [
      item.project.name,
      item.project.repository,
      item.projectTypeLabel
    ].some((value) => value.toLowerCase().includes(normalizedQuery))
  })
}

export function getProjectCompositeStatus(
  project: Project,
  projectRuns: WorkflowRun[]
): ProjectSelectorStatus {
  const runStatuses = projectRuns.map((run) => run.status)

  if (runStatuses.includes("failed")) {
    return status("needs_attention", "failed")
  }

  if (runStatuses.includes("waiting_for_approval")) {
    return status("needs_attention", "waiting_for_approval")
  }

  if (runStatuses.includes("running")) {
    return status("running", "running")
  }

  if (
    runStatuses.some(isActiveRunStatus) ||
    project.status === "active" ||
    project.status === "waiting_for_approval" ||
    project.status === "stopped" ||
    project.status === "failed"
  ) {
    return status(
      project.status === "failed" ? "needs_attention" : "active",
      project.status
    )
  }

  return status("done", project.status)
}

export function formatRelativeActivityTime(
  value: string | undefined,
  now = new Date()
) {
  const activityTime = parseActivityTime(value)

  if (activityTime === 0) {
    return "Unknown activity"
  }

  const diffMs = Math.max(0, now.getTime() - activityTime)
  const minute = 60 * 1000
  const hour = 60 * minute
  const day = 24 * hour

  if (diffMs < minute) {
    return "just now"
  }

  if (diffMs < hour) {
    const minutes = Math.floor(diffMs / minute)
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"} ago`
  }

  if (diffMs < day) {
    const hours = Math.floor(diffMs / hour)
    return `${hours} ${hours === 1 ? "hour" : "hours"} ago`
  }

  if (diffMs < 2 * day) {
    return "yesterday"
  }

  const days = Math.floor(diffMs / day)
  return `${days} days ago`
}

export function formatAbsoluteActivityTime(value: string | undefined) {
  const activityTime = parseActivityTime(value)

  if (activityTime === 0) {
    return "Unknown activity"
  }

  const date = new Date(activityTime)
  const year = date.getUTCFullYear()
  const month = String(date.getUTCMonth() + 1).padStart(2, "0")
  const day = String(date.getUTCDate()).padStart(2, "0")
  const hours = String(date.getUTCHours()).padStart(2, "0")
  const minutes = String(date.getUTCMinutes()).padStart(2, "0")

  return `${year}-${month}-${day} ${hours}:${minutes}`
}

function compareActivityDescending(a: string | undefined, b: string | undefined) {
  return parseActivityTime(b) - parseActivityTime(a)
}

function parseActivityTime(value: string | undefined) {
  if (!value) {
    return 0
  }

  const time = Date.parse(value)
  return Number.isNaN(time) ? 0 : time
}

function status(
  group: ProjectSelectorStatusGroup,
  label: string
): ProjectSelectorStatus {
  return {
    group,
    label,
    dotVariant: group
  }
}

function isActiveRunStatus(status: WorkflowStatus) {
  return status === "pending" || status === "stopped"
}

function stageDisplay(stage: string) {
  return stage.charAt(0).toUpperCase() + stage.slice(1).replace(/_/g, " ")
}
