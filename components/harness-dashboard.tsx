"use client"

import {
  Bot,
  Check,
  ChevronRight,
  CircleDot,
  ClipboardList,
  FileUp,
  GitBranch,
  Play,
  RefreshCw,
  SlidersHorizontal,
  ShieldCheck,
  UserCheck,
  X
} from "lucide-react"
import { ChangeEvent, FormEvent, useMemo, useState } from "react"
import type { CSSProperties } from "react"
import type {
  AgentKind,
  ApprovalActorType,
  ApprovalGate,
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

const defaultEventSkills = createDefaultEventSkills()
const defaultSkillAssignments = Object.fromEntries(
  defaultEventSkills.map((skill) => [skill.id, "codex" as AgentKind])
) as Record<string, AgentKind>

const sampleRequirement =
  "Build a harness dashboard that can select Codex/OpenClaw agents and control design/verification with approval gates."

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
  const [importedRequirementName, setImportedRequirementName] = useState("")
  const [openComposeSection, setOpenComposeSection] = useState<
    "requirement" | "automation" | undefined
  >()
  const [form, setForm] = useState({
    projectName: "Harness MVP",
    repository: "owner/repository",
    requirement: sampleRequirement,
    selectedAgent: "codex" as AgentKind,
    skillAssignments: defaultSkillAssignments,
    designApprovalActor: "independent_agent" as ApprovalActorType,
    verificationApprovalActor: "verification_subagent" as ApprovalActorType
  })

  const selectedRun = useMemo(
    () => runs.find((run) => run.id === selectedRunId) ?? runs[0],
    [runs, selectedRunId]
  )

  async function refreshRuns() {
    const response = await fetch("/api/workflow-runs", { cache: "no-store" })
    const data = (await response.json()) as WorkflowRun[]
    setRuns(data)
    setSelectedRunId((current) => current ?? data[0]?.id)
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
    setForm({
      ...form,
      selectedAgent,
      skillAssignments: Object.fromEntries(
        defaultEventSkills.map((skill) => [skill.id, selectedAgent])
      ) as Record<string, AgentKind>
    })
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

  async function importRequirementFile(
    event: ChangeEvent<HTMLInputElement>
  ) {
    const file = event.target.files?.[0]

    if (!file) {
      return
    }

    const text = await file.text()
    setForm((currentForm) => ({
      ...currentForm,
      requirement: text
    }))
    setImportedRequirementName(file.name)
    event.target.value = ""
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Agentic Delivery Harness</p>
          <h1>Harness Framework</h1>
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
                {form.selectedAgent} - design and verification gates
              </small>
            </span>
            <ChevronRight size={18} />
          </button>

          <button className="primaryButton createRunButton" disabled={isMutating}>
            <Play size={17} />
            Create Run
          </button>

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
                          {importedRequirementName ? (
                            <small>{importedRequirementName}</small>
                          ) : null}
                          <span
                            className="iconTextButton importButton"
                            tabIndex={0}
                          >
                            <FileUp size={15} />
                            Import .md
                            <input
                              accept=".md,.markdown,text/markdown,text/plain"
                              className="fileImportInput"
                              onChange={importRequirementFile}
                              type="file"
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
                    </label>
                  </div>
                ) : (
                  <div className="composeSheetBody">
                    <fieldset>
                      <legend>Default Development Agent</legend>
                      <AgentSelect
                        value={form.selectedAgent}
                        onChange={updateSelectedAgent}
                      />
                    </fieldset>

                    <fieldset>
                      <legend>Skill Executors</legend>
                      <div className="skillAssignmentList">
                        {defaultEventSkills.map((skill) => (
                          <div className="skillAssignmentRow" key={skill.id}>
                            <div>
                              <strong>{skill.name}</strong>
                              <small>{eventTypeLabels[skill.eventType]}</small>
                            </div>
                            <AgentSelect
                              value={
                                form.skillAssignments[skill.id] ??
                                form.selectedAgent
                              }
                              onChange={(agent) =>
                                updateSkillAssignment(skill.id, agent)
                              }
                            />
                          </div>
                        ))}
                      </div>
                    </fieldset>

                    <div className="policyGrid">
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
          disabled={isMutating || run.status === "waiting_for_approval"}
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
              <div className={stageClass} key={stage}>
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
                    {agentRun.agent} - {agentRun.status}
                  </small>
                </div>
              ))
            )}
          </div>
        </div>
      </section>

      <section className="lowerGrid">
        <section className="panel scrollPanel">
          <div className="panelHeader">
            <ClipboardList size={18} />
            <h2>Event Skill Chain</h2>
          </div>
          <div className="skillChain">
            {run.eventSkills.map((skill) => {
              const matchingEvents = run.events.filter(
                (event) => event.skillId === skill.id
              )
              const latestEvent = matchingEvents[matchingEvents.length - 1]
              const executor = run.skillAssignments[skill.id] ?? run.selectedAgent

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
                    <StatusPill status={latestEvent?.status ?? "pending"} />
                  </div>
                  <p>{skill.purpose}</p>
                  <div className="skillMetaGrid">
                    <SkillMeta title="Executor" values={[executor]} />
                    <SkillMeta title="Trigger" values={[skill.trigger]} />
                    <SkillMeta
                      title="Knowledge"
                      values={skill.knowledgeSources}
                    />
                    <SkillMeta title="Constraints" values={skill.constraints} />
                    <SkillMeta title="Gates" values={skill.gates} />
                  </div>
                </article>
              )
            })}
          </div>
        </section>

        <section className="panel scrollPanel">
          <div className="panelHeader">
            <Bot size={18} />
            <h2>Artifacts</h2>
          </div>
          <div className="artifactList">
            {run.artifacts.map((artifact) => (
              <article className="artifact" key={artifact.id}>
                <div>
                  <strong>{artifact.title}</strong>
                  <small>
                    {stageLabels[artifact.stage]} - {artifact.type}
                  </small>
                </div>
                <pre>{artifact.body}</pre>
              </article>
            ))}
          </div>
        </section>
      </section>
    </div>
  )
}

function AgentSelect({
  value,
  onChange
}: {
  value: AgentKind
  onChange: (value: AgentKind) => void
}) {
  return (
    <SegmentedControl
      value={value}
      options={[
        ["codex", "Codex"],
        ["openclaw", "OpenClaw"],
        ["manual", "Manual"]
      ]}
      onChange={(nextValue) => onChange(nextValue as AgentKind)}
    />
  )
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
