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
  Play,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  SlidersHorizontal,
  ShieldCheck,
  Trash2,
  UserCheck,
  X
} from "lucide-react"
import {
  ChangeEvent,
  FormEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from "react"
import type { CSSProperties } from "react"
import {
  agentProfiles,
  defaultAgentKind,
  getAgentLabel,
  type AgentProfile
} from "@/lib/agents"
import type {
  AgentKind,
  ApprovalActorType,
  ApprovalGate,
  ProjectContextFile,
  WorkflowRun,
  WorkflowStage
} from "@/lib/types"
import {
  actorLabels,
  createDefaultEventSkills,
  eventTypeLabels,
  stageLabels
} from "@/lib/workflow"

const orderedStages: WorkflowStage[] = [
  "intake",
  "plan",
  "design",
  "implementation",
  "verification",
  "completed"
]
const agentMenuMaxHeight = 268
const folderPickerAttributes = {
  directory: "",
  webkitdirectory: ""
} as Record<string, string>

const defaultEventSkills = createDefaultEventSkills()
const defaultSkillAssignments = Object.fromEntries(
  defaultEventSkills.map((skill) => [skill.id, defaultAgentKind])
) as Record<string, AgentKind>

const sampleRequirement =
  "Build a Jormungandr dashboard that can select Codex/OpenClaw agents and control design/verification with approval gates."

export function HarnessDashboard({
  initialRuns
}: {
  initialRuns: WorkflowRun[]
}) {
  const [runs, setRuns] = useState<WorkflowRun[]>(initialRuns)
  const [selectedRunId, setSelectedRunId] = useState<string | undefined>(
    initialRuns[0]?.id
  )
  const [isLoading, setIsLoading] = useState(false)
  const [isMutating, setIsMutating] = useState(false)
  const [openComposeSection, setOpenComposeSection] = useState<
    "requirement" | "automation" | undefined
  >()
  const [skillSearch, setSkillSearch] = useState("")
  const [showOverridesOnly, setShowOverridesOnly] = useState(false)
  const [bulkStage, setBulkStage] = useState<WorkflowStage | "all">("all")
  const [bulkAgent, setBulkAgent] = useState<AgentKind>(defaultAgentKind)
  const [form, setForm] = useState({
    projectName: "Jormungandr MVP",
    repository: "owner/repository",
    requirement: sampleRequirement,
    contextFiles: [] as ProjectContextFile[],
    selectedAgent: defaultAgentKind,
    skillAssignments: defaultSkillAssignments,
    designApprovalActor: "independent_agent" as ApprovalActorType,
    verificationApprovalActor: "verification_subagent" as ApprovalActorType
  })

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0],
    [runs, selectedRunId]
  )
  const overrideCount = useMemo(
    () =>
      defaultEventSkills.filter(
        (skill) =>
          (form.skillAssignments[skill.id] ?? form.selectedAgent) !==
          form.selectedAgent
      ).length,
    [form.selectedAgent, form.skillAssignments]
  )
  const visibleAssignmentSkills = useMemo(() => {
    const query = skillSearch.trim().toLowerCase()

    return defaultEventSkills.filter((skill) => {
      const executor = form.skillAssignments[skill.id] ?? form.selectedAgent
      const isOverride = executor !== form.selectedAgent
      const matchesQuery =
        query.length === 0 ||
        skill.name.toLowerCase().includes(query) ||
        eventTypeLabels[skill.eventType].toLowerCase().includes(query) ||
        stageLabels[skill.stage].toLowerCase().includes(query)

      return matchesQuery && (!showOverridesOnly || isOverride)
    })
  }, [
    form.selectedAgent,
    form.skillAssignments,
    showOverridesOnly,
    skillSearch
  ])

  async function refreshRuns() {
    const response = await fetch("/api/workflow-runs", { cache: "no-store" })
    const data = (await response.json()) as WorkflowRun[]
    setRuns(data)
    setSelectedRunId((current) =>
      data.some((run) => run.id === current) ? current : data[0]?.id
    )
    setIsLoading(false)
  }

  async function createRun(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setIsMutating(true)
    const response = await fetch("/api/workflow-runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form)
    })
    const run = (await response.json()) as WorkflowRun
    await refreshRuns()
    setSelectedRunId(run.id)
    setIsMutating(false)
  }

  async function advanceRun(runId: string) {
    setIsMutating(true)
    const response = await fetch(`/api/workflow-runs/${runId}/advance`, {
      method: "POST"
    })
    const run = (await response.json()) as WorkflowRun
    await refreshRuns()
    setSelectedRunId(run.id)
    setIsMutating(false)
  }

  async function stopRun(runId: string) {
    setIsMutating(true)
    const response = await fetch(`/api/workflow-runs/${runId}/stop`, {
      method: "POST"
    })
    const run = (await response.json()) as WorkflowRun
    await refreshRuns()
    setSelectedRunId(run.id)
    setIsMutating(false)
  }

  async function cancelRun(run: WorkflowRun) {
    const confirmed = window.confirm(
      `Cancel "${run.projectName}" and delete all artifacts for this run?`
    )

    if (!confirmed) {
      return
    }

    setIsMutating(true)
    await fetch(`/api/workflow-runs/${run.id}/cancel`, {
      method: "POST"
    })
    await refreshRuns()
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
    const run = (await response.json()) as WorkflowRun
    await refreshRuns()
    setSelectedRunId(run.id)
    setIsMutating(false)
  }

  function updateSelectedAgent(selectedAgent: AgentKind) {
    setForm((currentForm) => ({
      ...currentForm,
      selectedAgent,
      skillAssignments: Object.fromEntries(
        defaultEventSkills.map((skill) => {
          const currentAgent =
            currentForm.skillAssignments[skill.id] ??
            currentForm.selectedAgent

          return [
            skill.id,
            currentAgent === currentForm.selectedAgent
              ? selectedAgent
              : currentAgent
          ]
        })
      ) as Record<string, AgentKind>
    }))
  }

  function updateSkillAssignment(skillId: string, agent: AgentKind) {
    setForm({
      ...form,
      skillAssignments: {
        ...form.skillAssignments,
        [skillId]: agent
      }
    })
  }

  function applyBulkAssignment() {
    setForm((currentForm) => ({
      ...currentForm,
      skillAssignments: Object.fromEntries(
        defaultEventSkills.map((skill) => {
          const currentAgent =
            currentForm.skillAssignments[skill.id] ??
            currentForm.selectedAgent
          const shouldApply = bulkStage === "all" || skill.stage === bulkStage

          return [skill.id, shouldApply ? bulkAgent : currentAgent]
        })
      ) as Record<string, AgentKind>
    }))
  }

  function resetSkillAssignments() {
    setForm((currentForm) => ({
      ...currentForm,
      skillAssignments: Object.fromEntries(
        defaultEventSkills.map((skill) => [skill.id, currentForm.selectedAgent])
      ) as Record<string, AgentKind>
    }))
  }

  async function importContextFiles(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const files = Array.from(event.target.files ?? [])

    if (files.length === 0) {
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

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Agentic Delivery System</p>
          <h1>Jormungandr</h1>
        </div>
        <button className="iconButton" onClick={refreshRuns} title="Refresh">
          <RefreshCw size={18} />
        </button>
      </header>

      <section className="layoutGrid">
        <form className="panel composePanel" onSubmit={createRun}>
          <div className="panelHeader">
            <CircleDot size={18} />
            <h2>New Workflow Run</h2>
          </div>

          <button
            className="composeLaunchButton"
            onClick={() => setOpenComposeSection("requirement")}
            type="button"
          >
            <ClipboardList size={18} />
            <span>
              <strong>Project / Repository / Requirement</strong>
              <small>
                {form.projectName} - {form.repository}
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
              <strong>Agent / Skills / Approval Policies</strong>
              <small>
                {getAgentLabel(form.selectedAgent)} - design and verification gates
              </small>
            </span>
            <ChevronRight size={18} />
          </button>

          <div className="runActionRow">
            <button
              className="primaryButton createRunButton"
              disabled={isMutating}
            >
              <Play size={17} />
              Create Run
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
              title="Cancel selected run and delete its artifacts"
              type="button"
            >
              <Trash2 size={17} />
              Cancel Run
            </button>
          </div>

          {openComposeSection ? (
            <div className="composeOverlay" role="dialog" aria-modal="true">
              <div className="composeSheet">
                <div className="composeSheetHeader">
                  <div>
                    <p className="eyebrow">Workflow Setup</p>
                    <h2>
                      {openComposeSection === "requirement"
                        ? "Project / Repository / Requirement"
                        : "Agent / Skills / Approval Policies"}
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

                    <label>
                      <span>Repository</span>
                      <input
                        value={form.repository}
                        onChange={(event) =>
                          setForm({ ...form, repository: event.target.value })
                        }
                      />
                    </label>

                    <label>
                      <span className="requirementHeader">
                        <span>Requirement</span>
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
                  </div>
                ) : (
                  <div className="composeSheetBody">
                    <section className="assignmentWorkbench">
                      <div className="assignmentHeader">
                        <div>
                          <h3>Assignment Workbench</h3>
                          <p>
                            Route each workflow skill to an executor. Skills use
                            the default unless you override them.
                          </p>
                        </div>
                        <div className="assignmentSummary">
                          <strong>{overrideCount}</strong>
                          <span>overrides</span>
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
                        <label className="searchField">
                          <span>Search Skills</span>
                          <span className="searchInputWrap">
                            <Search size={15} />
                            <input
                              value={skillSearch}
                              onChange={(event) =>
                                setSkillSearch(event.target.value)
                              }
                              placeholder="Stage, event, or skill name"
                            />
                          </span>
                        </label>

                        <label>
                          <span>Bulk Scope</span>
                          <select
                            className="plainSelect"
                            value={bulkStage}
                            onChange={(event) =>
                              setBulkStage(
                                event.target.value as WorkflowStage | "all"
                              )
                            }
                          >
                            <option value="all">All stages</option>
                            {orderedStages
                              .filter((stage) => stage !== "completed")
                              .map((stage) => (
                                <option key={stage} value={stage}>
                                  {stageLabels[stage]}
                                </option>
                              ))}
                          </select>
                        </label>

                        <label>
                          <span>Bulk Executor</span>
                          <AgentSelect
                            value={bulkAgent}
                            onChange={setBulkAgent}
                          />
                        </label>

                        <div className="toolbarActions">
                          <button
                            className="iconTextButton applyBulkButton"
                            onClick={applyBulkAssignment}
                            type="button"
                          >
                            <Check size={15} />
                            Apply
                          </button>
                          <button
                            className={
                              showOverridesOnly
                                ? "iconTextButton activeFilter"
                                : "iconTextButton"
                            }
                            onClick={() =>
                              setShowOverridesOnly((current) => !current)
                            }
                            type="button"
                          >
                            <SlidersHorizontal size={15} />
                            Overrides
                          </button>
                          <button
                            className="iconTextButton"
                            onClick={resetSkillAssignments}
                            type="button"
                          >
                            <RotateCcw size={15} />
                            Reset
                          </button>
                        </div>
                      </div>

                      <div className="assignmentTable" role="table">
                        <div className="assignmentTableHead" role="row">
                          <span>Stage</span>
                          <span>Skill</span>
                          <span>Executor</span>
                          <span>Policy</span>
                        </div>
                        {visibleAssignmentSkills.length === 0 ? (
                          <div className="assignmentEmpty">
                            No matching skills.
                          </div>
                        ) : (
                          visibleAssignmentSkills.map((skill) => {
                            const executor =
                              form.skillAssignments[skill.id] ??
                              form.selectedAgent
                            const isOverride = executor !== form.selectedAgent

                            return (
                              <div
                                className="assignmentTableRow"
                                key={skill.id}
                                role="row"
                              >
                                <span className={`stageBadge ${skill.stage}`}>
                                  {stageLabels[skill.stage]}
                                </span>
                                <div className="skillCell">
                                  <strong>{skill.name}</strong>
                                  <small>{eventTypeLabels[skill.eventType]}</small>
                                </div>
                                <div className="executorCell">
                                  <AgentSelect
                                    value={executor}
                                    menuPlacement="up"
                                    onChange={(agent) =>
                                      updateSkillAssignment(skill.id, agent)
                                    }
                                  />
                                  <small>
                                    {isOverride
                                      ? "Custom assignment"
                                      : `Uses default: ${getAgentLabel(
                                          form.selectedAgent
                                        )}`}
                                  </small>
                                </div>
                                <span className={`policyBadge ${skill.stage}`}>
                                  {getSkillPolicyLabel(skill.stage)}
                                </span>
                              </div>
                            )
                          })
                        )}
                      </div>

                      <div className="policyGrid assignmentPolicyGrid">
                        <fieldset>
                          <legend>Design Approval Policy</legend>
                          <ActorSelect
                            value={form.designApprovalActor}
                            onChange={(designApprovalActor) =>
                              setForm({ ...form, designApprovalActor })
                            }
                          />
                        </fieldset>

                        <fieldset>
                          <legend>Verification Approval Policy</legend>
                          <ActorSelect
                            value={form.verificationApprovalActor}
                            onChange={(verificationApprovalActor) =>
                              setForm({ ...form, verificationApprovalActor })
                            }
                          />
                        </fieldset>
                      </div>
                    </section>
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

        <section className="workspace">
          <div className="panel runsPanel">
            <div className="panelHeader">
              <GitBranch size={18} />
              <h2>Workflow Runs</h2>
            </div>
            {isLoading ? (
              <p className="muted">Loading</p>
            ) : runs.length === 0 ? (
              <p className="muted">No runs yet</p>
            ) : (
              <div className="runList">
                {runs.map((run) => (
                  <button
                    key={run.id}
                    className={
                      run.id === selectedRun?.id ? "runRow active" : "runRow"
                    }
                    onClick={() => setSelectedRunId(run.id)}
                  >
                    <span>{run.projectName}</span>
                    <small>
                      {stageLabels[run.currentStage]} - {run.status}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </div>

          {selectedRun ? (
            <RunDetail
              run={selectedRun}
              isMutating={isMutating}
              onAdvance={advanceRun}
              onDecideGate={decideGate}
            />
          ) : (
            <div className="panel emptyState">
              <Bot size={22} />
              <p>Create a workflow run to start.</p>
            </div>
          )}
        </section>
      </section>
    </main>
  )
}

function RunDetail({
  run,
  isMutating,
  onAdvance,
  onDecideGate
}: {
  run: WorkflowRun
  isMutating: boolean
  onAdvance: (runId: string) => void
  onDecideGate: (
    gate: ApprovalGate,
    decision: "approved" | "rejected" | "changes_requested"
  ) => void
}) {
  const pendingGate = run.approvalGates.find((gate) => gate.status === "pending")
  const [openDetailSection, setOpenDetailSection] = useState<
    "skills" | "artifacts" | undefined
  >()

  return (
    <div className="detailStack">
      <section className="panel heroPanel">
        <div>
          <p className="eyebrow">{run.repository || "No repository"}</p>
          <h2>{run.projectName}</h2>
          <p className="requirement">{run.requirement}</p>
        </div>
        <button
          className="primaryButton"
          disabled={
            isMutating ||
            run.status === "waiting_for_approval" ||
            isTerminalStatus(run.status)
          }
          onClick={() => onAdvance(run.id)}
          title="Advance workflow"
        >
          <ChevronRight size={18} />
          Advance
        </button>
      </section>

      <section className="panel timelinePanel">
        <div className="stageTrack">
          {orderedStages.map((stage) => {
            const stageIndex = orderedStages.indexOf(stage)
            const currentIndex = orderedStages.indexOf(run.currentStage)
            const progress =
              stageIndex < currentIndex
                ? 100
                : stageIndex === currentIndex
                  ? run.currentStage === "completed"
                    ? 100
                    : 68
                  : 0
            const stageClass =
              stageIndex < currentIndex ||
              (stage === "completed" && run.currentStage === "completed")
                ? "stage done"
                : stageIndex === currentIndex
                  ? "stage current"
                  : "stage"

            return (
              <div className={`${stageClass} ${stage}`} key={stage}>
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
                <small>{stageLabels[stage]}</small>
              </div>
            )
          })}
        </div>
      </section>

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
            <div className="gateActions">
              <button
                className="iconTextButton approve"
                onClick={() => onDecideGate(pendingGate, "approved")}
              >
                <Check size={16} />
                Approve
              </button>
              <button
                className="iconTextButton request"
                onClick={() => onDecideGate(pendingGate, "changes_requested")}
              >
                <RefreshCw size={16} />
                Changes
              </button>
              <button
                className="iconTextButton reject"
                onClick={() => onDecideGate(pendingGate, "rejected")}
              >
                <X size={16} />
                Reject
              </button>
            </div>
          ) : null}
        </div>

        <div className="panel">
          <div className="panelHeader">
            <UserCheck size={18} />
            <h2>Agent Runs</h2>
          </div>
          <div className="agentList">
            {run.agentRuns.length === 0 ? (
              <p className="muted">No agent activity yet</p>
            ) : (
              run.agentRuns.map((agentRun) => (
                <div className="agentRow" key={agentRun.id}>
                  <strong>{stageLabels[agentRun.stage]}</strong>
                  <small>
                    {getAgentLabel(agentRun.agent)} - {agentRun.status}
                  </small>
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
                      (event) => event.skillId === skill.id
                    )
                    const latestEvent = matchingEvents[matchingEvents.length - 1]
                    const executor =
                      run.skillAssignments[skill.id] ?? run.selectedAgent

                    return (
                      <article className="skillCard" key={skill.id}>
                        <div className="skillCardHeader">
                          <div>
                            <strong>{skill.name}</strong>
                            <small>
                              {eventTypeLabels[skill.eventType]} -{" "}
                              {stageLabels[skill.stage]}
                            </small>
                          </div>
                          <StatusPill
                            status={latestEvent?.status ?? "pending"}
                          />
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
      label: "Codex",
      agents: agentProfiles.filter((agent) => agent.family === "codex")
    },
    {
      label: "OpenClaw",
      agents: agentProfiles.filter((agent) => agent.family === "openclaw")
    },
    {
      label: "Manual",
      agents: agentProfiles.filter((agent) => agent.family === "manual")
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
  if (agent.id === "openclaw.rowlet") {
    return (
      <span className="agentMark" aria-hidden="true">
        🦉
      </span>
    )
  }

  if (agent.id === "openclaw.roaringmoon") {
    return (
      <span className="agentMark" aria-hidden="true">
        🌙
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

  return null
}

function ActorSelect({
  value,
  onChange
}: {
  value: ApprovalActorType
  onChange: (value: ApprovalActorType) => void
}) {
  return (
    <SegmentedControl
      value={value}
      options={[
        ["human", "Human"],
        ["verification_subagent", "Verify"],
        ["independent_agent", "Independent"]
      ]}
      onChange={(nextValue) => onChange(nextValue as ApprovalActorType)}
    />
  )
}

function SegmentedControl({
  value,
  options,
  onChange
}: {
  value: string
  options: Array<[string, string]>
  onChange: (value: string) => void
}) {
  return (
    <div className="segmented">
      {options.map(([optionValue, label]) => (
        <button
          type="button"
          className={value === optionValue ? "selected" : ""}
          key={optionValue}
          onClick={() => onChange(optionValue)}
        >
          {label}
        </button>
      ))}
    </div>
  )
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
  return status !== "completed"
}

function isTerminalStatus(status: WorkflowRun["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled"
}
