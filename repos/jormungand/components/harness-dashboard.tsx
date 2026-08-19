"use client"

import Image from "next/image"
import { createPortal } from "react-dom"
import {
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  ClipboardList,
  FileUp,
  FolderUp,
  GitBranch,
  Menu,
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Square,
  Plus,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
  UserCheck,
  Wifi,
  WifiOff,
  X
} from "lucide-react"
import {
  ChangeEvent,
  FormEvent,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
import type { CSSProperties } from "react"
import { TaskConversation } from "@/components/task-conversation"
import { TaskStatusSidebar } from "@/components/task-status-sidebar"
import {
  agentProfiles,
  defaultAgentKind,
  getAgentLabel,
  normalizeAgentKind,
  type AgentProfile
} from "@/lib/agents"
import type {
  AgentKind,
  ApprovalGate,
  CodexReasoningIntensity,
  HarnessState,
  Project,
  ProjectContextFile,
  ProjectOverview,
  ProjectType,
  WorkflowRun,
  WorkflowStage
} from "@/lib/types"
import type { ConversationEntry } from "@/lib/hive-memory/types"
import type { HiveMemoryHealthSummary } from "@/lib/hive-health"
import type { AgentQuota } from "@/lib/agent-quota"
import { getProjectTemplate } from "@/lib/project-templates"
import { GlobalModeNav } from "@/components/global-mode-nav"
import {
  buildProjectSelectorItems,
  filterProjectSelectorItems,
  type ProjectSelectorFilter,
  type ProjectSelectorItem
} from "@/lib/project-selector"
import {
  actorLabels,
  createDefaultEventSkills,
  createResearchEventSkills,
  eventTypeLabels,
  stageLabels
} from "@/lib/workflow"

const codexModelOptions = [
  "ChatGPT OAuth",
  "gpt-5",
  "gpt-5-mini",
  "gpt-4.1",
  "gpt-4o",
  "gpt-4o-mini",
  "o3-mini",
  "o1-mini"
]
const codexReasoningIntensityOptions: Array<{
  value: CodexReasoningIntensity
  label: string
}> = [
  { value: "auto", label: "Auto" },
  { value: "low", label: "低" },
  { value: "medium", label: "中" },
  { value: "high", label: "高" }
]
const agentMenuMaxHeight = 268
const folderPickerAttributes = {
  directory: "",
  webkitdirectory: ""
} as Record<string, string>

const defaultEventSkills = createDefaultEventSkills()

function getAssignableEventSkills(projectType: ProjectType) {
  if (projectType === "agent_task") {
    return []
  }

  if (projectType === "research") {
    return createResearchEventSkills().filter(
      (skill) => skill.id !== "intake.requirement" && skill.id !== "closeout.archive"
    )
  }

  return defaultEventSkills
}

const maxContextFileBytes = 2 * 1024 * 1024
const maxContextTotalBytes = 5 * 1024 * 1024
const bridgeHealthPollIntervalMs = 10_000
const bridgeHealthStaleAfterMs = 30_000
const bridgeOfflineFailureThreshold = 2
const workflowSetupStoragePrefix = "jormungand.workflowSetupProfiles.v2"
type ApprovalDecision = "approved" | "rejected" | "changes_requested"
type BridgeHealthStatus = "online" | "offline"
type BridgePanelStatus = BridgeHealthStatus | "checking" | "stale"
type BridgeId = "codex-bridge" | "openclaw-bridge"
type MobilePanel = "modes" | "navigation" | "monitoring"

interface BridgeHealth {
  id: BridgeId
  label: string
  status: BridgeHealthStatus
  urlHost: string
  protocolVersion?: string
  capabilities?: string[]
  message?: string
}

interface AgentHealthResponse {
  checkedAt: string
  bridges: BridgeHealth[]
}

const sampleRequirement =
  "Build a Jormungandr dashboard that can select Arceus/OpenClaw agents and control design/verification with approval gates."

interface StageAssignment {
  id: string
  stageName: string
  skillId: string
  agent: AgentKind
}

function getWorkflowSetupStorageKey(projectType: ProjectType) {
  return `${workflowSetupStoragePrefix}:${projectType}`
}

function normalizeAgentInput(value: string | undefined, fallbackAgent: AgentKind) {
  return normalizeAgentKind(value ?? fallbackAgent)
}

function readWorkflowSetupProfile(
  projectType: ProjectType,
  fallbackAgent: AgentKind
) {
  if (typeof window === "undefined") {
    return {
      selectedAgent: fallbackAgent,
      stageAssignments: []
    }
  }

  const key = getWorkflowSetupStorageKey(projectType)
  const raw = window.localStorage.getItem(key)

  if (!raw) {
    return {
      selectedAgent: fallbackAgent,
      stageAssignments: []
    }
  }

  try {
    const parsed = JSON.parse(raw) as {
      selectedAgent?: string
      stageAssignments?: Array<{
        id?: string
        stageName?: string
        skillId?: string
        agent?: string
      }>
    }
    const selectedAgent = normalizeAgentInput(
      typeof parsed.selectedAgent === "string" ? parsed.selectedAgent : undefined,
      fallbackAgent
    )
    const stageAssignments = Array.isArray(parsed.stageAssignments)
      ? parsed.stageAssignments
          .filter(
            (entry) =>
              typeof entry === "object" &&
              entry !== null &&
              typeof entry.skillId === "string"
          )
          .map((entry) => {
            const safeEntry = entry as {
              id?: string
              stageName?: string
              skillId: string
              agent?: string
            }

            return {
              id:
                typeof safeEntry.id === "string" && safeEntry.id.trim().length > 0
                  ? safeEntry.id
                  : crypto.randomUUID(),
              stageName:
                typeof safeEntry.stageName === "string" ? safeEntry.stageName : "",
              skillId: safeEntry.skillId,
              agent: normalizeAgentInput(safeEntry.agent, selectedAgent)
            }
          })
      : []

    return {
      selectedAgent,
      stageAssignments
    }
  } catch {
    return {
      selectedAgent: fallbackAgent,
      stageAssignments: []
    }
  }
}

function writeWorkflowSetupProfile(
  projectType: ProjectType,
  selectedAgent: AgentKind,
  stageAssignments: StageAssignment[]
) {
  if (typeof window === "undefined") {
    return
  }

  window.localStorage.setItem(
    getWorkflowSetupStorageKey(projectType),
    JSON.stringify({ selectedAgent, stageAssignments })
  )
}

function getStageAssignmentsFromRows(
  projectType: ProjectType,
  rows: StageAssignment[]
) {
  return Object.fromEntries(
    rows
      .map((row) => [row.skillId, row.agent])
  ) as Record<string, AgentKind>
}

function splitLines(value: string) {
  return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

export function HarnessDashboard({
  initialState,
  initialHiveHealth
}: {
  initialState: HarnessState
  initialHiveHealth: HiveMemoryHealthSummary
}) {
  const [projects, setProjects] = useState<Project[]>(initialState.projects)
  const [runs, setRuns] = useState<WorkflowRun[]>(initialState.workflowRuns)
  const [selectedProjectId, setSelectedProjectId] = useState<
    string | undefined
  >()
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>()
  const [isLoading, setIsLoading] = useState(false)
  const [isMutating, setIsMutating] = useState(false)
  const [isNavigationExpanded, setIsNavigationExpanded] = useState(true)
  const [isMonitoringExpanded, setIsMonitoringExpanded] = useState(true)
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>()
  const [mutationError, setMutationError] = useState<string | undefined>()
	  const [conversationEntries, setConversationEntries] = useState<ConversationEntry[]>([])
	  const [conversationVersion, setConversationVersion] = useState(0)
	  const [openComposeSection, setOpenComposeSection] = useState<
	    "requirement" | "automation" | undefined
	  >()
	  const [form, setForm] = useState(() => {
	    const savedProfile = readWorkflowSetupProfile(
	      "development",
	      defaultAgentKind
	    )

	    return {
	      projectName: "Jormungandr MVP",
	      projectType: "development" as ProjectType,
	      repository: "",
	      requirement: sampleRequirement,
	      successCriteria: "",
	      constraints: "",
	      nonGoals: "",
      contextFiles: [] as ProjectContextFile[],
      selectedAgent: savedProfile.selectedAgent,
      stageAssignments: savedProfile.stageAssignments
	    }
	  })

  const projectSelectorItems = useMemo(
    () => buildProjectSelectorItems(projects, runs),
    [projects, runs]
  )
  const selectedProject = useMemo(
    () =>
      projectSelectorItems.find((item) => item.project.id === selectedProjectId)
        ?.project,
    [projectSelectorItems, selectedProjectId]
  )
  const selectedProjectRuns = useMemo(
    () =>
      selectedProject
        ? runs.filter((run) => run.projectId === selectedProject.id)
        : [],
    [runs, selectedProject]
  )
  const selectedRun = useMemo(
    () =>
      selectedProjectRuns.find((run) => run.id === selectedRunId) ??
      selectedProjectRuns[0],
    [selectedProjectRuns, selectedRunId]
  )
  const selectedOverview = useMemo(
    () =>
      selectedProject
        ? buildProjectOverview(selectedProject, selectedProjectRuns)
      : undefined,
    [selectedProject, selectedProjectRuns]
  )
	  const [superpowersSkills, setSuperpowersSkills] = useState<typeof defaultEventSkills>([])
	  useEffect(() => {
	    let active = true
	    fetch("/api/superpowers-skills")
	      .then((response) => response.ok ? response.json() : Promise.reject())
	      .then((payload: { skills?: Array<{ id: string; name: string }> }) => {
	        if (!active) return
	        const template = defaultEventSkills.find((skill) => skill.id === "implementation.dispatch") ?? defaultEventSkills[0]
	        if (!template) return
	        setSuperpowersSkills((payload.skills ?? []).map((skill) => ({
	          ...template,
	          id: skill.id,
	          name: skill.name,
	          purpose: `Execute the ${skill.name} Superpowers skill.`,
	          runtimeSkillBundles: []
	        })))
	      })
	      .catch(() => undefined)
	    return () => { active = false }
	  }, [])
	  const isAgentTask = form.projectType === "agent_task"
	  const isArceusMaintenance = form.projectType === "arceus_maintenance"
	  const assignmentSkills = useMemo(
	    () => form.projectType === "agent_task" ? [] : superpowersSkills,
	    [form.projectType, superpowersSkills]
	  )
	  const assignmentSkillById = useMemo(
	    () =>
	      Object.fromEntries(assignmentSkills.map((skill) => [skill.id, skill])),
	    [assignmentSkills]
	  )
	  const hasApprovalPolicies = form.projectType === "development"
	  const overrideCount = new Set(
	    form.stageAssignments.map((entry) => entry.skillId)
	  ).size
	  const stageAssignmentsMap = useMemo(
	    () => getStageAssignmentsFromRows(form.projectType, form.stageAssignments),
	    [form.projectType, form.stageAssignments]
	  )

	  function getCodexProfileForProject(projectId?: string) {
    const projectRuns = projectId
      ? runs
          .filter((run) => run.projectId === projectId)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      : selectedRun?.selectedAgent === "codex"
        ? [selectedRun]
        : []
    const activeRun = projectRuns[0]

    if (!activeRun) {
      return {}
    }

    return {
      selectedModelId: activeRun.selectedModelId?.trim() || undefined,
      selectedReasoningIntensity: activeRun.selectedReasoningIntensity
    }
  }
	  useEffect(() => {
	    writeWorkflowSetupProfile(
	      form.projectType,
	      form.selectedAgent,
	      form.stageAssignments
	    )
	  }, [form.projectType, form.selectedAgent, form.stageAssignments])

  async function refreshWorkspace() {
    const [projectsResponse, runsResponse] = await Promise.all([
      fetch("/api/projects", { cache: "no-store" }),
      fetch("/api/workflow-runs", { cache: "no-store" })
    ])
    const nextProjects = (await projectsResponse.json()) as Project[]
    const nextRuns = (await runsResponse.json()) as WorkflowRun[]
    setProjects(nextProjects)
    setRuns(nextRuns)
    setSelectedProjectId((current) =>
      nextProjects.some((project) => project.id === current)
        ? current
        : undefined
    )
    setSelectedRunId((current) => {
      if (nextRuns.some((run) => run.id === current)) {
        return current
      }

      const activeProjectId = nextProjects.some((project) => project.id === selectedProjectId)
        ? selectedProjectId
        : undefined
      const latestRun = nextRuns
        .filter((run) => run.projectId === activeProjectId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]

      return latestRun?.id
    })
    setIsLoading(false)
  }

  async function createProject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsMutating(true)
    setMutationError(undefined)

    try {
      const response = await fetch("/api/projects", {
        method: "POST",
              headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.projectName,
          type: form.projectType,
          goal: form.requirement,
          repository: form.repository,
          successCriteria: splitLines(form.successCriteria),
          constraints: splitLines(form.constraints),
          nonGoals: splitLines(form.nonGoals),
          contextFiles: form.contextFiles
        })
      })
      const project = await readProjectMutationResponse(response)
      const codexProfile = getCodexProfileForProject(project.id)
      const run = isAgentTask
        ? await readRunMutationResponse(
            await fetch(`/api/projects/${project.id}/workflow-runs`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                selectedAgent: form.selectedAgent,
                ...codexProfile
              })
            })
          )
        : undefined

      await refreshWorkspace()
      setSelectedProjectId(project.id)
      setSelectedRunId(run?.id)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsMutating(false)
    }
  }

  function updateCodexProfileForRun(input: {
    runId: string
    selectedModelId: string
    selectedReasoningIntensity: CodexReasoningIntensity
  }) {
    setRuns((currentRuns) =>
      currentRuns.map((run) =>
        run.id === input.runId
          ? {
              ...run,
              selectedModelId: input.selectedModelId,
              selectedReasoningIntensity: input.selectedReasoningIntensity
            }
          : run
      )
    )
  }

  async function startProjectRun(project: Project) {
    setIsMutating(true)
    setMutationError(undefined)

    try {
      const response = await fetch(`/api/projects/${project.id}/workflow-runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          selectedAgent: form.selectedAgent,
          ...getCodexProfileForProject(project.id),
          skillAssignments: stageAssignmentsMap,
          stageAssignments: form.stageAssignments
        })
      })
      const run = await readRunMutationResponse(response)
      await refreshWorkspace()
      setSelectedProjectId(project.id)
      setSelectedRunId(run.id)
    } catch (error) {
      setMutationError(error instanceof Error ? error.message : String(error))
    } finally {
      setIsMutating(false)
    }
  }

  async function advanceRun(runId: string) {
    setIsMutating(true)
    const response = await fetch(`/api/workflow-runs/${runId}/advance`, {
      method: "POST"
    })
    const run = await readRunMutationResponse(response)
    await refreshWorkspace()
    setSelectedRunId(run.id)
    setIsMutating(false)
  }

  async function stopRun(runId: string) {
    setIsMutating(true)
    const response = await fetch(`/api/workflow-runs/${runId}/stop`, {
      method: "POST"
    })
    const run = await readRunMutationResponse(response)
    await refreshWorkspace()
    setSelectedRunId(run.id)
    setIsMutating(false)
  }

  async function cancelRun(run: WorkflowRun) {
    const confirmed = window.confirm(
      `Cancel "${run.projectName}" and preserve its artifacts for review?`
    )

    if (!confirmed) {
      return
    }

    setIsMutating(true)
    await fetch(`/api/workflow-runs/${run.id}/cancel`, {
      method: "POST"
    })
    await refreshWorkspace()
    setIsMutating(false)
  }

  async function decideGate(
    gate: ApprovalGate,
    decision: "approved" | "rejected" | "changes_requested"
  ) {
    setIsMutating(true)
    const response = await fetch(`/api/approval-gates/${gate.id}/decide`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ decision })
    })
    const run = await readRunMutationResponse(response)
    await refreshWorkspace()
    setSelectedRunId(run.id)
    setIsMutating(false)
  }

  function updateSelectedAgent(selectedAgent: AgentKind) {
    setForm((currentForm) => ({
      ...currentForm,
      selectedAgent
    }))
  }

  function selectProjectType(projectType: ProjectType) {
    const template = getProjectTemplate(projectType)
    const savedProfile = readWorkflowSetupProfile(
      projectType,
      form.selectedAgent
    )

    setForm((currentForm) => ({
      ...currentForm,
      projectType,
      selectedAgent: savedProfile.selectedAgent,
      stageAssignments: savedProfile.stageAssignments,
      repository: projectType === "agent_task" || projectType === "arceus_maintenance"
        ? ""
        : currentForm.repository,
    }))
    setMutationError(template.warning)
  }

  function addStageAssignment() {
    const defaultSkill = assignmentSkills[0]

    if (!defaultSkill) {
      return
    }

    setForm((currentForm) => ({
      ...currentForm,
      stageAssignments: [
        ...currentForm.stageAssignments,
        {
          id: crypto.randomUUID(),
          stageName: stageLabels[defaultSkill.stage],
          skillId: defaultSkill.id,
          agent: currentForm.selectedAgent
        }
      ]
    }))
  }

  function updateStageAssignment(
    rowId: string,
    patch: Partial<StageAssignment>
  ) {
    setForm((currentForm) => ({
      ...currentForm,
      stageAssignments: currentForm.stageAssignments.map((row) =>
        row.id === rowId
          ? { ...row, ...patch }
          : row
      )
    }))
  }

  function removeStageAssignment(rowId: string) {
    setForm((currentForm) => ({
      ...currentForm,
      stageAssignments: currentForm.stageAssignments.filter((row) => row.id !== rowId)
    }))
  }

  async function importContextFiles(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const files = Array.from(event.target.files ?? [])

    if (files.length === 0) {
      return
    }

    const oversizedFile = files.find((file) => file.size > maxContextFileBytes)
    const totalBytes =
      form.contextFiles.reduce((total, file) => total + file.size, 0) +
      files.reduce((total, file) => total + file.size, 0)

    if (oversizedFile || totalBytes > maxContextTotalBytes) {
      window.alert(
        "Context files are too large for the JSON-backed state store. Keep each file under 2 MB and the run under 5 MB."
      )
      event.target.value = ""
      return
    }

    const contextFiles = await Promise.all(files.map(readProjectContextFile))

    setForm((currentForm) => ({
      ...currentForm,
      contextFiles: mergeContextFiles(currentForm.contextFiles, contextFiles)
    }))
    event.target.value = ""
  }

  function removeContextFile(fileId: string) {
    setForm((currentForm) => ({
      ...currentForm,
      contextFiles: currentForm.contextFiles.filter((file) => file.id !== fileId)
    }))
  }

  async function readRunMutationResponse(response: Response) {
    const data = (await response.json()) as
      | WorkflowRun
      | { error?: string; latestRun?: WorkflowRun }

    if (response.ok) {
      return data as WorkflowRun
    }

    if (response.status === 409 && "latestRun" in data && data.latestRun) {
      return data.latestRun
    }

    throw new Error(("error" in data && data.error) || "Workflow mutation failed")
  }

  async function readProjectMutationResponse(response: Response) {
    const data = (await response.json()) as Project | { error?: string }

    if (response.ok) {
      return data as Project
    }

    throw new Error(("error" in data && data.error) || "Project mutation failed")
  }

  function handleNewConversation() {
    setConversationEntries([])
    setSelectedProjectId(undefined)
    setSelectedRunId(undefined)
    setConversationVersion((current) => current + 1)
  }

  useEffect(() => {
    if (!mobilePanel) return

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setMobilePanel(undefined)
    }

    window.addEventListener("keydown", closeOnEscape)
    return () => window.removeEventListener("keydown", closeOnEscape)
  }, [mobilePanel])

  return (
    <main className={`shell mode-${form.projectType}`}>
      <div className={`appChrome${mobilePanel === "modes" ? " mobilePanelOpen" : ""}`}>
        <div className="mobileDrawerHeader">
          <strong>Mode &amp; workspace</strong>
          <button aria-label="Close mode menu" className="iconButton" onClick={() => setMobilePanel(undefined)} type="button"><X size={18} /></button>
        </div>
        <GlobalModeNav
          value={form.projectType}
          onChange={(projectType) => {
            selectProjectType(projectType)
            setMobilePanel(undefined)
          }}
        />
        <header className="topbar">
          <div>
            <p className="eyebrow modeEyebrow">{getProjectTemplate(form.projectType).label} mode</p>
            <h1>{"Jormungand"}</h1>
          </div>
          <div className="topbarActions">
            <a className={`hiveHealthBadge ${initialHiveHealth.status}`} href="/api/hive-memory/health" title={`Hive memory integrity: ${initialHiveHealth.integrity}`}>
              <CircleDot size={13} />Memory {initialHiveHealth.status}
            </a>
            <button className="iconButton" onClick={refreshWorkspace} title="Refresh"><RefreshCw size={18} /></button>
          </div>
        </header>
      </div>

      <section
        className="taskWorkspaceGrid"
        data-left-collapsed={!isNavigationExpanded}
      >
        <aside className={`taskNavigation${isNavigationExpanded ? "" : " collapsed"}${mobilePanel === "navigation" ? " mobilePanelOpen" : ""}`}>
          <div className="mobileDrawerHeader">
            <strong>Projects &amp; runs</strong>
            <button aria-label="Close projects menu" className="iconButton" onClick={() => setMobilePanel(undefined)} type="button"><X size={18} /></button>
          </div>
          <button
            aria-expanded={isNavigationExpanded}
            aria-label={isNavigationExpanded ? "Collapse project navigation" : "Expand project navigation"}
            className="railToggle navigationRailToggle"
            onClick={() => setIsNavigationExpanded((current) => !current)}
            type="button"
          >
            {isNavigationExpanded ? <><span>Projects &amp; runs</span><ChevronDown size={16} /></> : <ChevronRight size={18} />}
          </button>
          {isNavigationExpanded ? <>
          <ProjectSelector
            isLoading={isLoading}
            items={projectSelectorItems}
            selectedProjectId={selectedProject?.id}
            onSelectProject={(item) => {
              setSelectedProjectId(item.project.id)
              setSelectedRunId(item.latestRun?.id)
              setMobilePanel(undefined)
            }}
          />
          <form className="panel composePanel" onSubmit={createProject}>
          <div className="panelHeader">
            <CircleDot size={18} />
            <h2>New Project</h2>
          </div>

          <button
            className="composeLaunchButton"
            onClick={() => setOpenComposeSection("requirement")}
            type="button"
          >
            <ClipboardList size={18} />
            <span>
              <strong>
                {isAgentTask
                  ? "Task / Agent Instruction"
                  : "Project / Repository / Requirement"}
              </strong>
              <small>
                {isAgentTask
                  ? form.requirement
                  : isArceusMaintenance
                    ? form.projectName
                  : `${form.projectName} - ${
                      form.repository || "GitHub repo not set"
                    }`}
              </small>
            </span>
            <ChevronRight size={18} />
          </button>

          <button
            className="composeLaunchButton"
            onClick={() => setOpenComposeSection("automation")}
            type="button"
          >
            <SlidersHorizontal size={18} />
            <span>
              <strong>
                {isAgentTask
                  ? "Agent"
                  : hasApprovalPolicies
                    ? "Agent / Skills / Approval Policies"
                    : "Agent / Skills"}
              </strong>
              <small>
                {isAgentTask
                  ? getAgentLabel(form.selectedAgent)
                  : hasApprovalPolicies
                    ? `${getAgentLabel(
                        form.selectedAgent
                      )} - design and verification gates`
                    : `${getAgentLabel(
                        form.selectedAgent
                      )} - ${assignmentSkills.length} workflow skills`}
              </small>
            </span>
            <ChevronRight size={18} />
          </button>

          <div className="runActionRow">
            <button
              className="primaryButton createRunButton"
              disabled={isMutating || (isArceusMaintenance && splitLines(form.successCriteria).length === 0)}
            >
              <Play size={17} />
              {isAgentTask ? "Run Task" : "Create Project"}
            </button>
            <button
              className="stopButton"
              disabled={
                isMutating ||
                !selectedRun ||
                !isStoppableStatus(selectedRun.status)
              }
              onClick={() => selectedRun && stopRun(selectedRun.id)}
              title="Stop selected run's current stage"
              type="button"
            >
              <Square size={16} />
              Stop Stage
            </button>
            <button
              className="dangerButton"
              disabled={
                isMutating ||
                !selectedRun ||
                !isCancelableStatus(selectedRun.status)
              }
              onClick={() => selectedRun && cancelRun(selectedRun)}
              title="Cancel selected run and preserve its artifacts"
              type="button"
            >
              <Trash2 size={17} />
              Cancel Run
            </button>
          </div>

          {mutationError ? (
            <p className="formError" role="alert">
              {mutationError}
            </p>
          ) : null}

          {openComposeSection ? (
            <div className="composeOverlay" role="dialog" aria-modal="true">
              <div className="composeSheet">
                <div className="composeSheetHeader">
                  <div>
                    <p className="eyebrow">Workflow Setup</p>
                    <h2>
                      {openComposeSection === "requirement"
                        ? isAgentTask
                          ? "Task / Agent Instruction"
                          : "Project / Repository / Requirement"
                        : isAgentTask
                          ? "Agent"
                          : hasApprovalPolicies
                            ? "Agent / Skills / Approval Policies"
                            : "Agent / Skills"}
                    </h2>
                  </div>
                  <button
                    className="iconButton"
                    onClick={() => setOpenComposeSection(undefined)}
                    title="Close"
                    type="button"
                  >
                    <X size={18} />
                  </button>
                </div>

                {openComposeSection === "requirement" ? (
                  <div className="composeSheetBody">
                    <label>
                      <span>Project</span>
                      <input
                        value={form.projectName}
                        onChange={(event) =>
                          setForm({ ...form, projectName: event.target.value })
                        }
                      />
                    </label>

                    {!isAgentTask && !isArceusMaintenance ? (
                      <label>
                        <span>Repository</span>
                        <input
                          placeholder="my-new-repo or owner/repository"
                          value={form.repository}
                          onChange={(event) =>
                            setForm({ ...form, repository: event.target.value })
                          }
                        />
                      </label>
                    ) : null}

                    <label>
                      <span className="requirementHeader">
                        <span>
                          {isAgentTask ? "Instruction" : "Requirement"}
                        </span>
                        <span className="requirementActions">
                          {form.contextFiles.length > 0 ? (
                            <small>
                              {form.contextFiles.length} files attached
                            </small>
                          ) : null}
                          <span
                            className="iconTextButton importButton"
                            tabIndex={0}
                          >
                            <FileUp size={15} />
                            Import File
                            <input
                              className="fileImportInput"
                              multiple
                              onChange={importContextFiles}
                              type="file"
                            />
                          </span>
                          <span
                            className="iconTextButton importButton"
                            tabIndex={0}
                          >
                            <FolderUp size={15} />
                            Import Folder
                            <input
                              className="fileImportInput"
                              multiple
                              onChange={importContextFiles}
                              type="file"
                              {...folderPickerAttributes}
                            />
                          </span>
                        </span>
                      </span>
                      <textarea
                        value={form.requirement}
                        onChange={(event) =>
                          setForm({ ...form, requirement: event.target.value })
                        }
                      />
                      {form.contextFiles.length > 0 ? (
                        <div className="contextFileList">
                          {form.contextFiles.map((file) => (
                            <span className="contextFileChip" key={file.id}>
                              <FileUp size={13} />
                              <span>
                                <strong>{file.path}</strong>
                                <small>{formatFileSize(file.size)}</small>
                              </span>
                              <button
                                aria-label={`Remove ${file.path}`}
                                onClick={() => removeContextFile(file.id)}
                                type="button"
                              >
                                <X size={13} />
                              </button>
                            </span>
                          ))}
                        </div>
                      ) : null}
                    </label>

                    {isArceusMaintenance ? (
                      <>
                        <label>
                          <span>Success criteria</span>
                          <textarea
                            placeholder="One criterion per line"
                            required={isArceusMaintenance}
                            value={form.successCriteria}
                            onChange={(event) =>
                              setForm({ ...form, successCriteria: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          <span>Constraints</span>
                          <textarea
                            placeholder="Optional; one constraint per line"
                            value={form.constraints}
                            onChange={(event) =>
                              setForm({ ...form, constraints: event.target.value })
                            }
                          />
                        </label>
                        <label>
                          <span>Non-goals</span>
                          <textarea
                            placeholder="Optional; one non-goal per line"
                            value={form.nonGoals}
                            onChange={(event) =>
                              setForm({ ...form, nonGoals: event.target.value })
                            }
                          />
                        </label>
                      </>
                    ) : null}
                  </div>
                ) : (
                  <div className="composeSheetBody">
                    {isAgentTask ? (
                      <section className="agentTaskAgentPanel">
                        <label>
                          <span>Agent</span>
                          <AgentSelect
                            value={form.selectedAgent}
                            onChange={updateSelectedAgent}
                          />
                        </label>
                      </section>
                    ) : (
                    <section className="assignmentWorkbench">
                      <div className="assignmentHeader">
                        <div>
                          <h3>Assignment Workbench</h3>
                          <p>
                            Route your custom workflow stages to executors.
                            Skills inherit the default executor when not listed below.
                          </p>
                        </div>
                        <div className="assignmentSummary">
                          <strong>{overrideCount}</strong>
                          <span>custom stages</span>
                        </div>
                      </div>

                      <div className="defaultExecutorRow">
                        <div>
                          <strong>Default Executor</strong>
                          <small>
                            Applied to skills without a custom assignment.
                          </small>
                        </div>
                        <AgentSelect
                          value={form.selectedAgent}
                          onChange={updateSelectedAgent}
                        />
                      </div>

                      <div className="assignmentToolbar">
                        <div className="toolbarActions">
                          <button
                            className="iconTextButton applyBulkButton"
                            disabled={assignmentSkills.length === 0}
                            onClick={addStageAssignment}
                            type="button"
                          >
                            <Plus size={15} />
                            Add Stage
                          </button>
                        </div>
                      </div>

                      <div className="assignmentTable" role="table">
                        <div className="assignmentTableHead" role="row">
                          <span>Stage</span>
                          <span>Skill</span>
                          <span>Executor</span>
                          <span>Policy</span>
                          <span></span>
                        </div>
                        {form.stageAssignments.length === 0 ? (
                          <div className="assignmentEmpty">
                            No custom stages yet.
                          </div>
                        ) : (
                          form.stageAssignments.map((row) => {
                            const skill = assignmentSkillById[row.skillId]
                            const policyLabel = skill
                              ? getSkillPolicyLabel(skill.stage)
                              : "No skill"
                            return (
                              <div
                                className="assignmentTableRow"
                                key={row.id}
                                role="row"
                              >
                                <input
                                  className="stageNameInput"
                                  value={row.stageName}
                                  onChange={(event) =>
                                    updateStageAssignment(row.id, {
                                      stageName: event.target.value
                                    })
                                  }
                                />
                                <div className="skillCell">
                                  <select
                                    className="plainSelect"
                                    value={row.skillId}
                                    onChange={(event) =>
                                      updateStageAssignment(row.id, {
                                        skillId: event.target.value
                                      })
                                    }
                                  >
                                    {assignmentSkills.map((availableSkill) => (
                                      <option
                                        key={availableSkill.id}
                                        value={availableSkill.id}
                                      >
                                        {availableSkill.name}
                                      </option>
                                    ))}
                                  </select>
                                  {skill ? (
                                    <small>{eventTypeLabels[skill.eventType]}</small>
                                  ) : null}
                                </div>
                                <div className="executorCell">
                                  <AgentSelect
                                    value={row.agent}
                                    menuPlacement="up"
                                    onChange={(agent) =>
                                      updateStageAssignment(row.id, { agent })
                                    }
                                  />
                                </div>
                                <span
                                  className={`policyBadge ${
                                    skill ? skill.stage : ""
                                  }`}
                                >
                                  {policyLabel}
                                </span>
                                <button
                                  aria-label="Remove stage assignment"
                                  className="iconButton assignmentRowRemove"
                                  onClick={() => removeStageAssignment(row.id)}
                                  type="button"
                                >
                                  <Trash2 size={14} />
                                </button>
                              </div>
                            )
                          })
                        )}
                      </div>

                    </section>
                    )}
                  </div>
                )}

                <div className="composeSheetFooter">
                  <button
                    className="primaryButton"
                    onClick={() => setOpenComposeSection(undefined)}
                    type="button"
                  >
                    Done
                  </button>
                </div>
              </div>
            </div>
          ) : null}
          </form>
          </> : null}
        </aside>

        <section className="conversationWorkspace">
          <nav aria-label="Mobile workspace controls" className="mobileTaskToolbar">
            <button aria-expanded={mobilePanel === "modes"} onClick={() => setMobilePanel("modes")} type="button"><SlidersHorizontal size={18} /><span>Mode</span></button>
            <button aria-expanded={mobilePanel === "navigation"} onClick={() => { setIsNavigationExpanded(true); setMobilePanel("navigation") }} type="button"><Menu size={18} /><span>Projects</span></button>
            <button aria-expanded={mobilePanel === "monitoring"} onClick={() => { setIsMonitoringExpanded(true); setMobilePanel("monitoring") }} type="button"><CircleDot size={18} /><span>Status</span></button>
          </nav>
          <TaskConversation
            key={`${selectedRun?.id ?? "unbound"}:${conversationVersion}`}
            run={selectedRun}
            initialEntries={[]}
            allowedAgents={selectedRun ? agentProfiles.map((profile) => profile.id) : agentProfiles.map((profile) => profile.id)}
            onEntriesChanged={setConversationEntries}
            onBound={(binding) => {
              setSelectedProjectId(binding.projectId)
              setSelectedRunId(binding.workflowRunId)
            }}
            onNewConversation={handleNewConversation}
          />
          {selectedProject && selectedOverview ? (
            <details className="projectDetailsDisclosure">
              <summary>Project and workflow details</summary>
              <ProjectDetail
                overview={selectedOverview}
                selectedRun={selectedRun}
                isMutating={isMutating}
                onStartRun={startProjectRun}
                onAdvance={advanceRun}
                onDecideGate={decideGate}
                onCancelRun={cancelRun}
                onStopRun={stopRun}
              />
            </details>
          ) : null}
        </section>
        <TaskStatusSidebar
          bridgeConnections={<BridgeStatusPanel
            onCodexProfileChange={updateCodexProfileForRun}
            run={selectedRun}
            showHeading={false}
          />}
          entries={selectedRun ? conversationEntries.filter((entry) => entry.workflowRunId === selectedRun.id) : []}
          isExpanded={isMonitoringExpanded}
          isMobileOpen={mobilePanel === "monitoring"}
          onMobileClose={() => setMobilePanel(undefined)}
          onExpandedChange={setIsMonitoringExpanded}
          run={selectedRun}
        />
      </section>
      {mobilePanel ? <button aria-label="Close open menu" className="mobilePanelBackdrop" onClick={() => setMobilePanel(undefined)} type="button" /> : null}
    </main>
  )
}

function ProjectSelector({
  isLoading,
  items,
  selectedProjectId,
  onSelectProject
}: {
  isLoading: boolean
  items: ProjectSelectorItem[]
  selectedProjectId?: string
  onSelectProject: (item: ProjectSelectorItem) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [filter, setFilter] = useState<ProjectSelectorFilter>("all")
  const selectedItem =
    items.find((item) => item.project.id === selectedProjectId)
  const visibleItems = filterProjectSelectorItems(items, query, filter)

  function clearFilters() {
    setQuery("")
    setFilter("all")
  }

  return (
    <div className="panel runsPanel projectSelector">
      <button
        aria-expanded={isOpen}
        className="projectSelectorSummary"
        onClick={() => items.length > 0 && setIsOpen((current) => !current)}
        type="button"
      >
        <span className="projectSelectorHeader">
          <span>
            <GitBranch size={18} />
            <strong>Projects</strong>
          </span>
          <ChevronDown size={18} />
        </span>

        {isLoading ? (
          <span className="muted">Loading</span>
        ) : selectedItem ? (
          <span className="projectSelectorCurrent">
            <span
              className={`projectStatusDot ${selectedItem.status.dotVariant}`}
              aria-hidden="true"
            />
            <span>
              <strong title={selectedItem.project.name}>
                {selectedItem.project.name}
              </strong>
              <small title={selectedItem.absoluteActivityLabel}>
                {selectedItem.projectTypeLabel} - {selectedItem.status.label} -{" "}
                {selectedItem.relativeActivityLabel}
              </small>
            </span>
          </span>
        ) : (
          <span className="muted">No project selected</span>
        )}
      </button>

      {isOpen ? (
        <div className="projectSelectorPopover">
          <div className="projectSelectorControls">
            <label className="projectSearch">
              <Search size={16} />
              <input
                aria-label="Search projects"
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search projects..."
                value={query}
              />
            </label>
            <div className="segmented projectFilter">
              {[
                ["all", "All"],
                ["active", "Active"],
                ["needs_attention", "Needs attention"],
                ["completed", "Completed"]
              ].map(([value, label]) => (
                <button
                  className={filter === value ? "selected" : ""}
                  key={value}
                  onClick={() => setFilter(value as ProjectSelectorFilter)}
                  type="button"
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {visibleItems.length === 0 ? (
            <div className="projectSelectorEmpty">
              <p className="muted">No projects found</p>
              <button
                className="iconTextButton"
                onClick={clearFilters}
                type="button"
              >
                <RotateCcw size={15} />
                Clear filters
              </button>
            </div>
          ) : (
            <div className="projectSelectorList">
              {visibleItems.map((item) => (
                <ProjectOption
                  item={item}
                  isSelected={item.project.id === selectedProjectId}
                  key={item.project.id}
                  onSelect={() => {
                    onSelectProject(item)
                    setIsOpen(false)
                  }}
                />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

function ProjectOption({
  item,
  isSelected,
  onSelect
}: {
  item: ProjectSelectorItem
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <button
      className={isSelected ? "projectOption selected" : "projectOption"}
      onClick={onSelect}
      type="button"
    >
      <span
        className={`projectStatusDot ${item.status.dotVariant}`}
        aria-hidden="true"
      />
      <span>
        <strong title={item.project.name}>{item.project.name}</strong>
        <small title={item.absoluteActivityLabel}>
          {item.projectTypeLabel} - {item.status.label} -{" "}
          {item.relativeActivityLabel}
        </small>
        <small>{item.latestRunSummary}</small>
      </span>
    </button>
  )
}

function buildProjectOverview(
  project: Project,
  workflowRuns: WorkflowRun[]
): ProjectOverview {
  const template = getProjectTemplate(project.type)
  const sortedRuns = [...workflowRuns].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt)
  )

  return {
    project,
    phaseLabels: template.phases,
    artifacts: sortedRuns.flatMap((run) => run.artifacts),
    pendingGates: sortedRuns.flatMap((run) =>
      run.approvalGates.filter((gate) => gate.status === "pending")
    ),
    agentRuns: sortedRuns.flatMap((run) => run.agentRuns),
    workflowEvents: sortedRuns.flatMap((run) => run.events),
    contextFiles: project.contextFiles,
    latestRun: sortedRuns[0],
    warning: template.warning
  }
}

function ProjectPhaseTimeline({ overview }: { overview: ProjectOverview }) {
  const currentIndex = Math.max(
    0,
    overview.phaseLabels.indexOf(overview.project.currentPhase)
  )

  return (
    <section className="panel timelinePanel">
      <div className="stageTrack">
        {overview.phaseLabels.map((phase, index) => {
          const progress =
            index < currentIndex
              ? 100
              : index === currentIndex
                ? phase === "Completed"
                  ? 100
                  : 68
                : 0
          const stageClass =
            index < currentIndex || phase === "Completed"
              ? "stage done"
              : index === currentIndex
                ? "stage current"
                : "stage"

          return (
            <div className={`${stageClass} projectPhase`} key={phase}>
              <span
                className="stageRing"
                style={
                  {
                    "--stage-progress": `${progress}%`
                  } as CSSProperties
                }
              >
                {progress}%
              </span>
              <small>{phase}</small>
            </div>
          )
        })}
      </div>
    </section>
  )
}

function ProjectDetail({
  overview,
  selectedRun,
  isMutating,
  onStartRun,
  onAdvance,
  onDecideGate,
  onCancelRun,
  onStopRun
}: {
  overview: ProjectOverview
  selectedRun?: WorkflowRun
  isMutating: boolean
  onStartRun: (project: Project) => void
  onAdvance: (runId: string) => void
  onDecideGate: (gate: ApprovalGate, decision: ApprovalDecision) => void
  onCancelRun: (run: WorkflowRun) => void
  onStopRun: (runId: string) => void
}) {
  const { project } = overview

  return (
    <div className="detailStack projectDetailStack">
      <section className="panel heroPanel">
        <div>
          <p className="eyebrow">
            {getProjectTemplate(project.type).label} -{" "}
            {project.repository || "No repository"}
          </p>
          <h2>{project.name}</h2>
          <p className="requirement">{project.goal}</p>
          <p className="muted">
            {project.currentPhase} - {project.status} - {project.nextAction}
          </p>
          {overview.warning ? <p className="muted">{overview.warning}</p> : null}
        </div>
        <div className="projectActionStack">
          <button
            className="primaryButton"
            disabled={isMutating}
            onClick={() => onStartRun(project)}
            title={
              project.type === "agent_task"
                ? "Run agent task"
                : "Start project run"
            }
          >
            <Play size={18} />
            {project.type === "agent_task" ? "Run Task" : "Start Run"}
          </button>
          {selectedRun && project.type !== "agent_task" ? (
            <button
              className="iconTextButton"
              disabled={
                isMutating ||
                selectedRun.status === "waiting_for_approval" ||
                isTerminalStatus(selectedRun.status)
              }
              onClick={() => onAdvance(selectedRun.id)}
              title="Advance selected project run"
            >
              <ChevronRight size={18} />
              Advance
            </button>
          ) : null}
        </div>
      </section>

      <ProjectPhaseTimeline overview={overview} />

      <section className="splitGrid">
        <div className="panel">
          <div className="panelHeader">
            <ShieldCheck size={18} />
            <h2>Command Queue</h2>
          </div>
          {overview.pendingGates.length === 0 ? (
            <p className="muted">No pending gates</p>
          ) : (
            <div className="gateList">
              {overview.pendingGates.map((gate) => (
                <div className="gateRow" key={gate.id}>
                  <div>
                    <strong>{stageLabels[gate.stage]}</strong>
                    <small>
                      {actorLabels[gate.actorType]}
                      {gate.requireIndependence ? " - independent" : ""}
                    </small>
                  </div>
                  <GateDecisionButtons
                    className="compact"
                    gate={gate}
                    isMutating={isMutating}
                    onDecideGate={onDecideGate}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="panel">
          <div className="panelHeader">
            <UserCheck size={18} />
            <h2>Context</h2>
          </div>
          {overview.contextFiles.length === 0 ? (
            <p className="muted">No context files attached</p>
          ) : (
            <div className="contextFileList">
              {overview.contextFiles.map((file) => (
                <span className="contextFileChip" key={file.id}>
                  <FileUp size={13} />
                  <span>
                    <strong>{file.path}</strong>
                    <small>{formatFileSize(file.size)}</small>
                  </span>
                </span>
              ))}
            </div>
          )}
        </div>
      </section>

      {selectedRun ? (
        <RunDetail
          isMutating={isMutating}
          run={selectedRun}
          onDecideGate={onDecideGate}
          onCancelRun={onCancelRun}
          onStopRun={onStopRun}
        />
      ) : (
        <section className="panel emptyState">
          <Bot size={22} />
          <p>Start a run to generate artifacts and execution history.</p>
        </section>
      )}
    </div>
  )
}

function RunDetail({
  isMutating,
  run,
  onDecideGate,
  onCancelRun,
  onStopRun
}: {
  isMutating: boolean
  run: WorkflowRun
  onDecideGate: (gate: ApprovalGate, decision: ApprovalDecision) => void
  onCancelRun: (run: WorkflowRun) => void
  onStopRun: (runId: string) => void
}) {
  const pendingGate = run.approvalGates.find((gate) => gate.status === "pending")
  const pendingApprovalSkillId = pendingGate
    ? `${pendingGate.stage}.approval`
    : undefined
  const [openDetailSection, setOpenDetailSection] = useState<
    "skills" | "artifacts" | undefined
  >()

  return (
    <div className="detailStack">
      <section className="splitGrid">
        <div className="panel">
          <div className="panelHeader">
            <ShieldCheck size={18} />
            <h2>Approval Gates</h2>
          </div>
          <div className="gateList">
            {run.approvalGates.length === 0 ? (
              <p className="muted">No gates opened yet</p>
            ) : (
              run.approvalGates.map((gate) => (
                <div className="gateRow" key={gate.id}>
                  <div>
                    <strong>{stageLabels[gate.stage]}</strong>
                    <small>
                      {actorLabels[gate.actorType]}
                      {gate.requireIndependence ? " - independent" : ""}
                    </small>
                  </div>
                  <StatusPill status={gate.status} />
                </div>
              ))
            )}
          </div>

          {pendingGate ? (
            <GateDecisionButtons
              gate={pendingGate}
              isMutating={isMutating}
              onDecideGate={onDecideGate}
            />
          ) : null}
        </div>

        <div className="panel">
          <div className="panelHeader">
            <UserCheck size={18} />
            <h2>Agent Runs</h2>
            <button
              className="dangerButton compactPanelButton"
              disabled={isMutating || !isCancelableStatus(run.status)}
              onClick={() => onCancelRun(run)}
              title="Cancel run"
              type="button"
            >
              <Trash2 size={15} />
              Cancel Run
            </button>
          </div>
          <div className="agentList">
            {run.agentRuns.length === 0 ? (
              <p className="muted">No agent activity yet</p>
            ) : (
              run.agentRuns.map((agentRun) => (
                <div className="agentRow" key={agentRun.id}>
                  <span className="agentRunInfo">
                    <strong>{stageLabels[agentRun.stage]}</strong>
                    <small>
                      {getAgentLabel(agentRun.agent)} - {agentRun.status}
                    </small>
                  </span>
                  {isActiveAgentRunStatus(agentRun.status) ? (
                    <button
                      className="stopButton compactPanelButton"
                      disabled={isMutating}
                      onClick={() => onStopRun(run.id)}
                      title="Stop task"
                      type="button"
                    >
                      <Square size={14} />
                      Stop task
                    </button>
                  ) : (
                    <StatusPill status={agentRun.status} />
                  )}
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="detailLaunchGrid">
        <button
          className="composeLaunchButton detailLaunchButton"
          onClick={() => setOpenDetailSection("skills")}
          type="button"
        >
          <ClipboardList size={18} />
          <span>
            <strong>Event Skill Chain</strong>
            <small>
              {run.eventSkills.length} skills - {run.events.length} events
              recorded
            </small>
          </span>
          <ChevronRight size={18} />
        </button>

        <button
          className="composeLaunchButton detailLaunchButton"
          onClick={() => setOpenDetailSection("artifacts")}
          type="button"
        >
          <Bot size={18} />
          <span>
            <strong>Artifacts</strong>
            <small>
              {run.artifacts.length} artifacts - {run.currentStage} stage
            </small>
          </span>
          <ChevronRight size={18} />
        </button>
      </section>

      {openDetailSection ? (
        <div className="composeOverlay" role="dialog" aria-modal="true">
          <div className="composeSheet">
            <div className="composeSheetHeader">
              <div>
                <p className="eyebrow">Run Detail</p>
                <h2>
                  {openDetailSection === "skills"
                    ? "Event Skill Chain"
                    : "Artifacts"}
                </h2>
              </div>
              <button
                className="iconButton"
                onClick={() => setOpenDetailSection(undefined)}
                title="Close"
                type="button"
              >
                <X size={18} />
              </button>
            </div>

            <div className="composeSheetBody">
              {openDetailSection === "skills" ? (
                <div className="skillChain">
                  {run.eventSkills.map((skill) => {
                    const matchingEvents = run.events.filter(
                      (event) =>
                        event.workflowRunId === run.id && event.skillId === skill.id
                    )
                    const latestEvent = [...matchingEvents].sort((a, b) =>
                      a.createdAt.localeCompare(b.createdAt)
                    )[matchingEvents.length - 1]
                    const executor =
                      run.skillAssignments[skill.id] ?? run.selectedAgent
                    const isPendingApprovalSkill =
                      Boolean(pendingGate) && skill.id === pendingApprovalSkillId

                    return (
                      <article
                        className={
                          isPendingApprovalSkill
                            ? "skillCard pendingGateSkill"
                            : "skillCard"
                        }
                        key={skill.id}
                      >
                        <div className="skillCardHeader">
                          <div className="skillCardTitle">
                            <strong>{skill.name}</strong>
                            <small>
                              {eventTypeLabels[skill.eventType]} -{" "}
                              {stageLabels[skill.stage]}
                            </small>
                          </div>
                          <div className="skillCardStatusColumn">
                            <StatusPill
                              status={latestEvent?.status ?? "pending"}
                            />
                            {isPendingApprovalSkill && pendingGate ? (
                              <GateDecisionButtons
                                className="skillGateActions"
                                gate={pendingGate}
                                isMutating={isMutating}
                                onDecideGate={onDecideGate}
                              />
                            ) : null}
                          </div>
                        </div>
                        <p>{skill.purpose}</p>
                        <div className="skillMetaGrid">
                          <SkillMeta
                            title="Executor"
                            values={[getAgentLabel(executor)]}
                          />
                          <SkillMeta title="Trigger" values={[skill.trigger]} />
                          <SkillMeta
                            title="Knowledge"
                            values={skill.knowledgeSources}
                          />
                          <SkillMeta
                            title="Constraints"
                            values={skill.constraints}
                          />
                          <SkillMeta title="Gates" values={skill.gates} />
                        </div>
                      </article>
                    )
                  })}
                </div>
              ) : (
                <div className="artifactList">
                  {run.artifacts.length === 0 ? (
                    <p className="muted">No artifacts yet</p>
                  ) : (
                    run.artifacts.map((artifact) => (
                      <article className="artifact" key={artifact.id}>
                        <div>
                          <strong>{artifact.title}</strong>
                          <small>
                            {stageLabels[artifact.stage]} - {artifact.type}
                          </small>
                        </div>
                        <pre>{artifact.body}</pre>
                      </article>
                    ))
                  )}
                </div>
              )}
            </div>

            <div className="composeSheetFooter">
              <button
                className="primaryButton"
                onClick={() => setOpenDetailSection(undefined)}
                type="button"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

function getSkillPolicyLabel(stage: WorkflowStage) {
  if (stage === "plan") {
    return "Human gate"
  }

  if (stage === "design") {
    return "Design gate"
  }

  if (stage === "verification") {
    return "Verification gate"
  }

  return "No gate"
}

const textFileExtensions = new Set([
  "css",
  "csv",
  "html",
  "js",
  "json",
  "jsx",
  "log",
  "md",
  "markdown",
  "mdx",
  "sql",
  "svg",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml"
])

async function readProjectContextFile(file: File): Promise<ProjectContextFile> {
  const path = getContextFilePath(file)
  const isText = isTextContextFile(file)

  return {
    id: crypto.randomUUID(),
    name: file.name,
    path,
    type: file.type || "application/octet-stream",
    size: file.size,
    encoding: isText ? "text" : "base64",
    content: isText ? await file.text() : await readFileAsBase64(file),
    importedAt: new Date().toISOString()
  }
}

function getContextFilePath(file: File) {
  const relativePath = (file as File & { webkitRelativePath?: string })
    .webkitRelativePath

  return relativePath || file.name
}

function isTextContextFile(file: File) {
  const extension = file.name.split(".").pop()?.toLowerCase() ?? ""

  return file.type.startsWith("text/") || textFileExtensions.has(extension)
}

function readFileAsBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader()

    reader.onerror = () => reject(reader.error)
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "")
      const [, base64 = ""] = dataUrl.split(",", 2)
      resolve(base64)
    }
    reader.readAsDataURL(file)
  })
}

function mergeContextFiles(
  existingFiles: ProjectContextFile[],
  incomingFiles: ProjectContextFile[]
) {
  const filesByPath = new Map(
    existingFiles.map((file) => [file.path, file] as const)
  )

  incomingFiles.forEach((file) => filesByPath.set(file.path, file))

  return Array.from(filesByPath.values())
}

function formatFileSize(bytes: number) {
  if (bytes <= 0) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB"]
  let size = bytes
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function BridgeStatusPanel({
  run,
  showHeading = true,
  onCodexProfileChange
}: {
  run?: WorkflowRun
  showHeading?: boolean
  onCodexProfileChange?: (input: {
    runId: string
    selectedModelId: string
    selectedReasoningIntensity: CodexReasoningIntensity
  }) => void
}) {
  const agentQuotaPollIntervalMs = 5 * 60 * 1000
  const [health, setHealth] = useState<Partial<Record<BridgeId, BridgeHealth>>>(
    {}
  )
  const [codexQuota, setCodexQuota] = useState<AgentQuota | undefined>()
  const [isChecking, setIsChecking] = useState(false)
  const [failureCount, setFailureCount] = useState(0)
  const [lastSuccessAt, setLastSuccessAt] = useState<string | undefined>()
  const [now, setNow] = useState(() => Date.now())

  async function refreshBridgeHealth() {
    setIsChecking(true)
    setNow(Date.now())

    try {
      const response = await fetch("/api/agent-health", { cache: "no-store" })
      const data = (await response.json()) as AgentHealthResponse

      if (!response.ok) {
        throw new Error("Bridge health request failed")
      }

      setHealth(
        Object.fromEntries(
          data.bridges.map((bridge) => [bridge.id, bridge])
        ) as Partial<Record<BridgeId, BridgeHealth>>
      )
      setLastSuccessAt(data.checkedAt)
      setFailureCount(0)
    } catch {
      setFailureCount((current) => current + 1)
    } finally {
      setIsChecking(false)
    }
  }

  async function refreshCodexQuota() {
    try {
      const response = await fetch("/api/agent-quotas", { cache: "no-store" })
      if (!response.ok) throw new Error("Agent quota request failed")

      const quotas = (await response.json()) as AgentQuota[]
      const quota = quotas.find((entry) => entry.agentId === "codex")
      setCodexQuota(quota)
    } catch {
      setCodexQuota(undefined)
    }
  }

  useLayoutEffect(() => {
    const initialCheckId = window.setTimeout(refreshBridgeHealth, 0)
    const initialQuotaCheckId = window.setTimeout(refreshCodexQuota, 0)
    const intervalId = window.setInterval(
      refreshBridgeHealth,
      bridgeHealthPollIntervalMs
    )
    const quotaIntervalId = window.setInterval(
      refreshCodexQuota,
      agentQuotaPollIntervalMs
    )
    const clockId = window.setInterval(() => setNow(Date.now()), 1000)

    return () => {
      window.clearTimeout(initialCheckId)
      window.clearTimeout(initialQuotaCheckId)
      window.clearInterval(intervalId)
      window.clearInterval(quotaIntervalId)
      window.clearInterval(clockId)
    }
  }, [agentQuotaPollIntervalMs])

  const isStale =
    lastSuccessAt &&
    now - new Date(lastSuccessAt).getTime() > bridgeHealthStaleAfterMs
  const panelStatus = getAggregateBridgeStatus({
    health,
    failureCount,
    isChecking,
    isStale: Boolean(isStale)
  })
  const visibleBridges = Object.values(health)

  return (
    <aside className="bridgeStatusPanel" aria-label="Agent bridge status">
      <div className="bridgeStatusPanelHeader">
        <span>
          {panelStatus === "online" ? <Wifi size={16} /> : <WifiOff size={16} />}
          {showHeading ? <strong>Bridge Connections</strong> : <span>{panelStatus}</span>}
        </span>
        <button
          className="iconButton bridgeRefreshButton"
          onClick={() => {
            void refreshBridgeHealth()
            void refreshCodexQuota()
          }}
          title="Refresh bridge health"
          type="button"
        >
          <RefreshCw size={14} />
        </button>
      </div>

      {visibleBridges.length === 0 ? (
        <p className="bridgeStatusEmpty">No bridge URLs registered</p>
      ) : (
        <div className="bridgeStatusCards">
          {visibleBridges.map((bridge) => (
            <BridgeStatusCard
              onCodexProfileChange={onCodexProfileChange}
              agents={getBridgeAgents(bridge.id)}
              failureCount={failureCount}
              health={bridge}
              quota={bridge.id === "codex-bridge" ? codexQuota : undefined}
              isChecking={isChecking}
              isStale={Boolean(isStale)}
              key={bridge.id}
              lastSuccessAt={lastSuccessAt}
              now={now}
              run={run}
            />
          ))}
        </div>
      )}
    </aside>
  )
}

function BridgeStatusCard({
  agents,
  failureCount,
  health,
  quota,
  isChecking,
  isStale,
  lastSuccessAt,
  now,
  run,
  onCodexProfileChange
}: {
  agents: AgentKind[]
  failureCount: number
  health: BridgeHealth
  quota?: AgentQuota
  isChecking: boolean
  isStale: boolean
  lastSuccessAt?: string
  now: number
  run?: WorkflowRun
  onCodexProfileChange?: (input: {
    runId: string
    selectedModelId: string
    selectedReasoningIntensity: CodexReasoningIntensity
  }) => void
}) {
  const status = getBridgePanelStatus({
    failureCount,
    health,
    isChecking,
    isStale
  })

  return (
    <article className={`bridgeStatusCard ${status}`}>
      <div className="bridgeStatusCardHeader">
        <span>
          <Server size={16} />
          <span>
            <strong>{health.label}</strong>
            <small>{health.urlHost}</small>
          </span>
        </span>
      </div>
      <div className="bridgeStatusMeta">
        <StatusPill status={status} />
        <small>{formatBridgeCheckedAt(lastSuccessAt, now)}</small>
      </div>
      {health?.message ? <p>{health.message}</p> : null}
      <div className="bridgeAgentRows">
        {agents.map((agent) => (
          <AgentBridgeRow
            agent={agent}
            key={agent}
            quota={agent === "codex" ? quota : undefined}
            run={run}
            onCodexProfileChange={onCodexProfileChange}
          />
        ))}
      </div>
    </article>
  )
}

function AgentBridgeRow({
  agent,
  quota,
  run,
  onCodexProfileChange
}: {
  agent: AgentKind
  quota?: AgentQuota
  run?: WorkflowRun
  onCodexProfileChange?: (input: {
    runId: string
    selectedModelId: string
    selectedReasoningIntensity: CodexReasoningIntensity
  }) => void
}) {
  const latestAgentRun = [...(run?.agentRuns ?? [])]
    .reverse()
    .find((agentRun) => agentRun.agent === agent)
  const profile = agentProfiles.find((candidate) => candidate.id === agent)
  const status = latestAgentRun?.status ?? "idle"
  const statusLabel = status === "failed" ? "FAIL" : status.toUpperCase()
  const initialModelId = run?.selectedModelId ?? "ChatGPT OAuth"
  const initialReasoningIntensity = run?.selectedReasoningIntensity ?? "auto"
  const [modelId, setModelId] = useState(initialModelId)
  const [reasoningIntensity, setReasoningIntensity] =
    useState<CodexReasoningIntensity>(initialReasoningIntensity)

  useEffect(() => {
    // This local control mirrors persisted run profile changes for the active row.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setModelId(run?.selectedModelId ?? "ChatGPT OAuth")
    setReasoningIntensity(run?.selectedReasoningIntensity ?? "auto")
  }, [run?.id, run?.selectedModelId, run?.selectedReasoningIntensity])

  if (!profile) {
    return null
  }

  const modelOptions = new Set([
    ...codexModelOptions,
    ...(run?.selectedModelId ? [run.selectedModelId] : [])
  ])

  function applyProfile(nextModelId: string, nextReasoningIntensity: CodexReasoningIntensity) {
    if (!run?.id || !onCodexProfileChange) {
      return
    }

    onCodexProfileChange({
      runId: run.id,
      selectedModelId: nextModelId,
      selectedReasoningIntensity: nextReasoningIntensity
    })
  }

  return (
    <div className={`bridgeAgentRow status-${status}`} role="status">
      <div className="bridgeAgentRowMain">
        <AgentOptionLabel agent={profile} />
        <strong className="bridgeAgentStatus">{statusLabel}</strong>
      </div>
      {agent === "codex" ? (
        <div className="bridgeAgentExecutionProfile">
          <label>
            <span>模型</span>
            <select
              aria-label="Codex model"
              className="plainSelect bridgeAgentSmallSelect"
              value={modelId}
              onChange={(event) => {
                const nextModelId = event.target.value
                setModelId(nextModelId)
                applyProfile(nextModelId, reasoningIntensity)
              }}
            >
              {Array.from(modelOptions).map((optionModelId) => (
                <option key={optionModelId} value={optionModelId}>
                  {optionModelId}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>思考強度</span>
            <select
              aria-label="Codex reasoning intensity"
              className="plainSelect bridgeAgentSmallSelect"
              value={reasoningIntensity}
              onChange={(event) => {
                const nextReasoningIntensity =
                  event.target.value as CodexReasoningIntensity
                setReasoningIntensity(nextReasoningIntensity)
                applyProfile(modelId, nextReasoningIntensity)
              }}
            >
              {codexReasoningIntensityOptions.map((option) => (
                <option value={option.value} key={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}
      {agent === "codex" ? <AgentQuotaBar quota={quota} /> : null}
    </div>
  )
}

function AgentQuotaBar({ quota }: { quota?: AgentQuota }) {
  const status = quota?.status ?? "unavailable"
  const isUnavailable = !quota || status === "unavailable"
  const remainingPercent = Math.max(
    0,
    Math.min(100, Math.round(quota?.remainingPercent ?? 0))
  )
  const label = isUnavailable ? "Unavailable" : `${remainingPercent}%`

  return (
    <div className={`agentQuotaBar status-${status}`}>
      <div className="agentQuotaTrackLabel">
        <span>Weekly HP</span>
        <strong>{label}</strong>
      </div>
      <div
        aria-label="Arceus remaining weekly quota"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={quota ? remainingPercent : undefined}
        aria-valuetext={label}
        className="agentQuotaTrack"
        role="progressbar"
      >
        <span className="agentQuotaFill" style={{ width: `${remainingPercent}%` }} />
      </div>
    </div>
  )
}

function getBridgeAgents(bridgeId: BridgeId): AgentKind[] {
  if (bridgeId === "codex-bridge") {
    return ["codex"]
  }

  return [
    "openclaw.rowlet",
    "openclaw.roaringmoon",
    "openclaw.charizard",
    "openclaw.mrmime",
    "openclaw.gengar"
  ]
}

function AgentSelect({
  menuPlacement = "down",
  value,
  onChange
}: {
  menuPlacement?: "down" | "up"
  value: AgentKind
  onChange: (value: AgentKind) => void
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({})
  const buttonRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const selectedAgent =
    agentProfiles.find((agent) => agent.id === value) ?? agentProfiles[0]
  const agentGroups = [
    {
      label: "Arceus",
      agents: agentProfiles.filter((agent) => agent.family === "codex")
    },
    {
      label: "OpenClaw",
      agents: agentProfiles.filter((agent) => agent.family === "openclaw")
    }
  ].filter((group) => group.agents.length > 0)

  useLayoutEffect(() => {
    if (!isOpen || !buttonRef.current) {
      return
    }

    function updateMenuPosition() {
      const button = buttonRef.current

      if (!button) {
        return
      }

      const gap = 5
      const viewportPadding = 8
      const rect = button.getBoundingClientRect()
      const spaceAbove = rect.top - gap - viewportPadding
      const spaceBelow = window.innerHeight - rect.bottom - gap - viewportPadding
      const shouldOpenUp =
        menuPlacement === "up" && spaceAbove > Math.min(spaceBelow, 120)
      const maxHeight = Math.max(
        120,
        Math.min(
          agentMenuMaxHeight,
          shouldOpenUp ? spaceAbove : Math.max(spaceBelow, spaceAbove)
        )
      )

      setMenuStyle({
        bottom: shouldOpenUp
          ? window.innerHeight - rect.top + gap
          : "auto",
        left: rect.left,
        maxHeight,
        position: "fixed",
        right: "auto",
        top: shouldOpenUp ? "auto" : rect.bottom + gap,
        width: rect.width
      })
    }

    updateMenuPosition()
    window.addEventListener("resize", updateMenuPosition)
    window.addEventListener("scroll", updateMenuPosition, true)

    return () => {
      window.removeEventListener("resize", updateMenuPosition)
      window.removeEventListener("scroll", updateMenuPosition, true)
    }
  }, [isOpen, menuPlacement])

  function keepOpenForTarget(target: Node | null) {
    return Boolean(
      target &&
        (wrapRef.current?.contains(target) || menuRef.current?.contains(target))
    )
  }

  const menu = (
    <div
      className="agentSelectMenu"
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null

        if (!keepOpenForTarget(nextTarget)) {
          setIsOpen(false)
        }
      }}
      ref={menuRef}
      role="listbox"
      style={menuStyle}
    >
      {agentGroups.map((group) => (
        <div className="agentSelectGroup" key={group.label}>
          <div className="agentSelectGroupLabel">{group.label}</div>
          {group.agents.map((agent) => (
            <button
              aria-selected={agent.id === value}
              className={
                agent.id === value
                  ? "agentSelectOption selected"
                  : "agentSelectOption"
              }
              key={agent.id}
              onClick={() => {
                onChange(agent.id)
                setIsOpen(false)
              }}
              role="option"
              type="button"
            >
              <AgentOptionLabel agent={agent} />
              {agent.id === value ? <Check size={14} /> : null}
            </button>
          ))}
        </div>
      ))}
    </div>
  )

  return (
    <span
      className={
        menuPlacement === "up"
          ? "agentSelectWrap menuUp"
          : "agentSelectWrap"
      }
      onBlur={(event) => {
        const nextTarget = event.relatedTarget as Node | null

        if (!keepOpenForTarget(nextTarget)) {
          setIsOpen(false)
        }
      }}
      ref={wrapRef}
    >
      <button
        aria-label="Agent executor"
        aria-expanded={isOpen}
        aria-haspopup="listbox"
        className="agentSelect"
        onClick={() => setIsOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            setIsOpen(false)
          }
        }}
        ref={buttonRef}
        type="button"
      >
        <AgentOptionLabel agent={selectedAgent} />
        <ChevronDown size={16} />
      </button>

      {isOpen && typeof document !== "undefined"
        ? createPortal(menu, document.body)
        : null}
    </span>
  )
}

function AgentOptionLabel({ agent }: { agent: AgentProfile }) {
  return (
    <span className="agentOptionLabel">
      <AgentIcon agent={agent} />
      <span>{agent.label}</span>
    </span>
  )
}

function AgentIcon({ agent }: { agent: AgentProfile }) {
  if (agent.id === "codex") {
    return (
      <span className="agentSpriteMark" aria-hidden="true">
        <Image
          alt=""
          height={24}
          src="/agents/arceus.jpg"
          unoptimized
          width={30}
        />
      </span>
    )
  }

  if (agent.id === "openclaw.rowlet") {
    return (
      <span className="agentSpriteMark" aria-hidden="true">
        <Image alt="" height={24} src="/agents/rowlet.png" unoptimized width={30} />
      </span>
    )
  }

  if (agent.id === "openclaw.roaringmoon") {
    return (
      <span className="agentSpriteMark" aria-hidden="true">
        <Image
          alt=""
          height={24}
          src="/agents/roaringmoon.png"
          unoptimized
          width={30}
        />
      </span>
    )
  }

  if (agent.id === "openclaw.charizard") {
    return (
      <span className="agentSpriteMark" aria-hidden="true">
        <Image
          alt=""
          height={24}
          src="/agents/charizard.webp"
          unoptimized
          width={30}
        />
      </span>
    )
  }

  if (agent.id === "openclaw.mrmime" || agent.id === "openclaw.gengar") {
    const sprite = agent.id === "openclaw.mrmime" ? "mrmime" : "gengar"
    return (
      <span className="agentSpriteMark" aria-hidden="true">
        <Image
          alt=""
          height={24}
          src={`/agents/${sprite}.${sprite === "gengar" ? "jpg" : "png"}`}
          unoptimized
          width={30}
        />
      </span>
    )
  }

  return null
}

function SkillMeta({ title, values }: { title: string; values: string[] }) {
  return (
    <div className="skillMeta">
      <span>{title}</span>
      <ul>
        {values.map((value) => (
          <li key={value}>{value}</li>
        ))}
      </ul>
    </div>
  )
}

function GateDecisionButtons({
  className,
  gate,
  isMutating,
  onDecideGate
}: {
  className?: string
  gate: ApprovalGate
  isMutating: boolean
  onDecideGate: (gate: ApprovalGate, decision: ApprovalDecision) => void
}) {
  const classes = ["gateActions", className].filter(Boolean).join(" ")

  return (
    <div className={classes}>
      <button
        className="iconTextButton approve"
        disabled={isMutating}
        onClick={() => onDecideGate(gate, "approved")}
        type="button"
      >
        <Check size={16} />
        Approve
      </button>
      <button
        className="iconTextButton request"
        disabled={isMutating}
        onClick={() => onDecideGate(gate, "changes_requested")}
        type="button"
      >
        <RefreshCw size={16} />
        Changes
      </button>
      <button
        className="iconTextButton reject"
        disabled={isMutating}
        onClick={() => onDecideGate(gate, "rejected")}
        type="button"
      >
        <X size={16} />
        Reject
      </button>
    </div>
  )
}

function getBridgePanelStatus({
  failureCount,
  health,
  isChecking,
  isStale
}: {
  failureCount: number
  health?: BridgeHealth
  isChecking: boolean
  isStale: boolean
}): BridgePanelStatus {
  if (isChecking && !health) {
    return "checking"
  }

  if (isStale && health?.status === "online") {
    return "stale"
  }

  if (failureCount >= bridgeOfflineFailureThreshold && !health) {
    return "offline"
  }

  return health?.status ?? "checking"
}

function getAggregateBridgeStatus({
  failureCount,
  health,
  isChecking,
  isStale
}: {
  failureCount: number
  health: Partial<Record<BridgeId, BridgeHealth>>
  isChecking: boolean
  isStale: boolean
}): BridgePanelStatus {
  const statuses = Object.values(health).map((bridge) =>
    getBridgePanelStatus({
      failureCount,
      health: bridge,
      isChecking,
      isStale
    })
  )

  if (statuses.some((status) => status === "online")) {
    return "online"
  }

  if (statuses.some((status) => status === "checking")) {
    return "checking"
  }

  if (failureCount >= bridgeOfflineFailureThreshold) {
    return "offline"
  }

  return statuses[0] ?? "checking"
}

function formatBridgeCheckedAt(value: string | undefined, now: number) {
  if (!value) {
    return "not checked"
  }

  const seconds = Math.max(
    0,
    Math.round((now - new Date(value).getTime()) / 1000)
  )

  return `${seconds}s ago`
}

function StatusPill({ status }: { status: string }) {
  return <span className={`statusPill ${status}`}>{status}</span>
}

function isStoppableStatus(status: WorkflowRun["status"]) {
  return (
    status === "pending" ||
    status === "running" ||
    status === "waiting_for_approval"
  )
}

function isCancelableStatus(status: WorkflowRun["status"]) {
  return status !== "completed" && status !== "failed" && status !== "cancelled"
}

function isTerminalStatus(status: WorkflowRun["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function isActiveAgentRunStatus(status: WorkflowRun["status"]) {
  return (
    status === "pending" ||
    status === "running" ||
    status === "waiting_for_approval"
  )
}
