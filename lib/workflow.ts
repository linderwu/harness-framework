import type {
  AgentKind,
  ApprovalActorType,
  ApprovalGate,
  ApprovalPolicy,
  Artifact,
  ExecutionMode,
  WorkflowEvent,
  WorkflowEventSkill,
  WorkflowEventType,
  WorkflowRun,
  WorkflowStage
} from "@/lib/types"
import type { AgentInvocationInput } from "@/lib/agent-bridge"

const stages: WorkflowStage[] = [
  "intake",
  "plan",
  "design",
  "implementation",
  "verification",
  "completed"
]

export const stageLabels: Record<WorkflowStage, string> = {
  intake: "Intake",
  plan: "Plan",
  design: "Design",
  implementation: "Implementation",
  verification: "Verification",
  completed: "Completed"
}

export const actorLabels: Record<ApprovalActorType, string> = {
  human: "Human",
  verification_subagent: "Verify Subagent",
  independent_agent: "Independent Agent"
}

export const eventTypeLabels: Record<WorkflowEventType, string> = {
  requirement_intake: "Requirement Intake",
  plan_interview: "Plan Interview",
  plan_approval: "Plan Approval",
  openspec_design: "OpenSpec Design",
  design_approval: "Design Approval",
  implementation_dispatch: "Implementation Dispatch",
  verification_generate: "Verification Generation",
  verification_approval: "Verification Approval",
  closeout: "Closeout"
}

export interface AgentArtifactResult {
  status: "completed" | "failed"
  source: "simulated" | "codex-bridge"
  body: string
  externalRunId?: string
}

export type AgentInvoker = (
  input: AgentInvocationInput
) => Promise<AgentArtifactResult | undefined>

export function createDefaultEventSkills(): WorkflowEventSkill[] {
  return [
    {
      id: "intake.requirement",
      eventType: "requirement_intake",
      stage: "intake",
      name: "Requirement Intake Skill",
      purpose: "Capture the user's development request as the first durable artifact.",
      trigger: "A dashboard request, GitHub issue, or imported requirement appears.",
      allowedActors: ["human", "codex", "openclaw"],
      inputs: ["raw requirement", "repository reference", "source metadata"],
      outputs: ["requirement artifact", "initial workflow run"],
      constraints: [
        "Do not design or implement during intake.",
        "Preserve the original requirement text.",
        "Attach source references when the request comes from GitHub."
      ],
      gates: ["Requirement must exist before planning can start."],
      knowledgeSources: ["omx_wiki/project-context", "GitHub issue body"],
      verificationRules: ["Requirement artifact is non-empty."]
    },
    {
      id: "plan.interview",
      eventType: "plan_interview",
      stage: "plan",
      name: "Plan Interview Skill",
      purpose: "Clarify scope, risks, acceptance criteria, and non-goals before design.",
      trigger: "Intake is complete and the run advances into planning.",
      allowedActors: ["human", "codex", "openclaw"],
      inputs: ["requirement artifact", "repository context", "omx_wiki pages"],
      outputs: ["plan artifact", "acceptance criteria", "risk list"],
      constraints: [
        "Ask or answer requirement questions before design starts.",
        "No implementation details may be committed in this event.",
        "Acceptance criteria must be testable."
      ],
      gates: ["PlanApproval must approve before design starts."],
      knowledgeSources: ["standard-dev-workflow", "omx_wiki", "GitHub issues"],
      verificationRules: [
        "Plan includes acceptance criteria.",
        "Plan names verification expectations."
      ]
    },
    {
      id: "plan.approval",
      eventType: "plan_approval",
      stage: "plan",
      name: "Plan Approval Skill",
      purpose: "Stop the workflow until the plan is accepted or revised.",
      trigger: "A plan artifact is generated.",
      allowedActors: ["human", "independent_agent"],
      inputs: ["plan artifact", "acceptance criteria"],
      outputs: ["approval decision"],
      constraints: [
        "A rejected plan cannot advance to design.",
        "Changes requested keep the run inside planning."
      ],
      gates: ["Approve, reject, or request changes."],
      knowledgeSources: ["standard-dev-workflow", "omx_wiki decisions"],
      verificationRules: ["Decision is recorded on the approval gate."]
    },
    {
      id: "design.openspec",
      eventType: "openspec_design",
      stage: "design",
      name: "OpenSpec Design Skill",
      purpose: "Turn an approved plan into OpenSpec-backed design artifacts.",
      trigger: "PlanApproval is approved.",
      allowedActors: ["codex", "openclaw", "human"],
      inputs: ["approved plan", "repository context", "architecture wiki"],
      outputs: ["OpenSpec change", "technical design", "task breakdown"],
      constraints: [
        "Design must not directly change product code.",
        "Task breakdown must map to verification rules.",
        "Open questions must be explicit."
      ],
      gates: ["DesignApproval must approve before implementation starts."],
      knowledgeSources: [
        "openspec-propose",
        "standard-dev-workflow",
        "omx_wiki/architecture"
      ],
      verificationRules: [
        "OpenSpec artifact exists.",
        "Design names tasks and test strategy."
      ]
    },
    {
      id: "design.approval",
      eventType: "design_approval",
      stage: "design",
      name: "Design Approval Skill",
      purpose: "Review the design before code is written.",
      trigger: "OpenSpec design artifact is generated.",
      allowedActors: ["human", "verification_subagent", "independent_agent"],
      inputs: ["OpenSpec change", "technical design", "plan artifact"],
      outputs: ["approval decision", "review note"],
      constraints: [
        "Prefer an independent reviewer when the implementation agent produced the design.",
        "Reject designs that lack verification strategy.",
        "Do not approve with unresolved blocking questions."
      ],
      gates: ["Approve, reject, or request redesign."],
      knowledgeSources: ["omx_wiki/architecture", "standard-dev-workflow"],
      verificationRules: ["Decision records actor and independence requirement."]
    },
    {
      id: "implementation.dispatch",
      eventType: "implementation_dispatch",
      stage: "implementation",
      name: "Implementation Dispatch Skill",
      purpose: "Send the approved design to the selected development agent.",
      trigger: "DesignApproval is approved.",
      allowedActors: ["codex", "openclaw", "human"],
      inputs: ["approved design", "task breakdown", "repository branch policy"],
      outputs: ["patch artifact", "branch plan", "agent run record"],
      constraints: [
        "Touch only files required by the approved design.",
        "Keep implementation within the selected task scope.",
        "Do not mark tasks complete without verification evidence."
      ],
      gates: ["Implementation output must enter verification."],
      knowledgeSources: ["standard-dev-workflow", "omx_wiki/conventions"],
      verificationRules: ["Agent run and implementation artifact are recorded."]
    },
    {
      id: "verification.generate",
      eventType: "verification_generate",
      stage: "verification",
      name: "Verification Generation Skill",
      purpose: "Generate and run tests against the implementation and acceptance criteria.",
      trigger: "Implementation dispatch completes.",
      allowedActors: ["codex", "openclaw", "verification_subagent"],
      inputs: ["patch artifact", "acceptance criteria", "test strategy"],
      outputs: ["test report", "coverage report", "manual checklist"],
      constraints: [
        "Tests must validate requirements, not merely current implementation.",
        "Coverage and failing checks must be visible.",
        "Security-sensitive work requires explicit review notes."
      ],
      gates: ["VerificationApproval must approve before PR-ready completion."],
      knowledgeSources: ["standard-dev-workflow", "omx_wiki/testing", "CI logs"],
      verificationRules: [
        "Verification report maps checks to acceptance criteria.",
        "Manual checklist exists for human-sensitive behavior."
      ]
    },
    {
      id: "verification.approval",
      eventType: "verification_approval",
      stage: "verification",
      name: "Verification Approval Skill",
      purpose: "Gate final readiness using a human, verify subagent, or independent agent.",
      trigger: "Verification report is generated.",
      allowedActors: ["human", "verification_subagent", "independent_agent"],
      inputs: ["test report", "coverage report", "manual checklist"],
      outputs: ["final verification decision"],
      constraints: [
        "Prefer independent review for high-risk changes.",
        "Failed verification returns to implementation.",
        "Approval must include an actor and timestamp."
      ],
      gates: ["Approve, fail, or request implementation changes."],
      knowledgeSources: ["omx_wiki/testing", "CI logs", "standard-dev-workflow"],
      verificationRules: ["Final decision is recorded before closeout."]
    },
    {
      id: "closeout.archive",
      eventType: "closeout",
      stage: "completed",
      name: "Closeout Skill",
      purpose: "Finalize the run and preserve artifacts for future wiki-backed learning.",
      trigger: "VerificationApproval is approved.",
      allowedActors: ["human", "codex", "openclaw"],
      inputs: ["all artifacts", "approval gates", "agent runs"],
      outputs: ["completed workflow run", "wiki capture candidate"],
      constraints: [
        "Do not discard failed or superseded artifacts.",
        "Capture reusable decisions into omx_wiki when enabled."
      ],
      gates: ["Run is complete."],
      knowledgeSources: ["omx_wiki/session-log"],
      verificationRules: ["Workflow status is completed."]
    }
  ]
}

export function createWorkflowRun(input: {
  projectName: string
  repository: string
  requirement: string
  selectedAgent: AgentKind
  skillAssignments?: Record<string, AgentKind>
  designApprovalActor: ApprovalActorType
  verificationApprovalActor: ApprovalActorType
}): WorkflowRun {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const eventSkills = createDefaultEventSkills()
  const requirementArtifact = createArtifact(
    id,
    "intake",
    "requirement",
    "Requirement",
    input.requirement
  )
  const stageModes = Object.fromEntries(
    stages.map((stage) => [stage, stage === "completed" ? "manual" : "hybrid"])
  ) as Record<WorkflowStage, ExecutionMode>
  const skillAssignments = Object.fromEntries(
    eventSkills.map((skill) => [
      skill.id,
      input.skillAssignments?.[skill.id] ?? input.selectedAgent
    ])
  ) as Record<string, AgentKind>

  const approvalPolicies: ApprovalPolicy[] = [
    {
      stage: "plan",
      actorType: "human",
      requireIndependence: false
    },
    {
      stage: "design",
      actorType: input.designApprovalActor,
      agent:
        input.designApprovalActor === "human" ? undefined : input.selectedAgent,
      requireIndependence: input.designApprovalActor === "independent_agent"
    },
    {
      stage: "verification",
      actorType: input.verificationApprovalActor,
      agent:
        input.verificationApprovalActor === "human"
          ? undefined
          : input.selectedAgent,
      requireIndependence: input.verificationApprovalActor === "independent_agent"
    }
  ]

  return {
    id,
    projectName: input.projectName,
    repository: input.repository,
    requirement: input.requirement,
    source: "dashboard",
    currentStage: "intake",
    status: "pending",
    selectedAgent: input.selectedAgent,
    stageModes,
    skillAssignments,
    approvalPolicies,
    eventSkills,
    events: [
      createWorkflowEvent({
        workflowRunId: id,
        skill: eventSkills[0],
        status: "completed",
        actor: skillAssignments["intake.requirement"],
        inputArtifactIds: [],
        outputArtifactIds: [requirementArtifact.id],
        note: "Initial requirement captured from dashboard."
      })
    ],
    artifacts: [requirementArtifact],
    approvalGates: [],
    agentRuns: [],
    createdAt: now,
    updatedAt: now
  }
}

export async function advanceWorkflow(
  run: WorkflowRun,
  options: { invokeAgent?: AgentInvoker } = {}
): Promise<WorkflowRun> {
  if (isTerminalStatus(run.status)) {
    return run
  }

  if (run.status === "waiting_for_approval") {
    return run
  }

  if (run.currentStage === "completed") {
    return run
  }

  const nextRun = cloneRun(run)
  ensureEventSkillState(nextRun)

  switch (nextRun.currentStage) {
    case "intake":
      nextRun.currentStage = "plan"
      nextRun.status = "running"
      const planResult = await addAgentArtifact(
        nextRun,
        "plan.interview",
        "plan",
        "plan",
        "Plan Draft",
        [
          `Project: ${nextRun.projectName}`,
          `Repository: ${nextRun.repository || "not linked yet"}`,
          "Acceptance criteria:",
          "- Requirement is captured as a first-class artifact.",
          "- Design approval must pass before implementation.",
          "- Verification approval must pass before PR-ready completion."
        ].join("\n"),
        options.invokeAgent
      )
      if (planResult.status === "failed") {
        break
      }
      openApprovalGate(nextRun, "plan")
      break
    case "plan":
      nextRun.currentStage = "design"
      nextRun.status = "running"
      const designResult = await addAgentArtifact(
        nextRun,
        "design.openspec",
        "design",
        "openspec",
        "OpenSpec Change Draft",
        [
          "Change: introduce agentic development harness workflow.",
          "Stages: plan, design, implementation, verification.",
          "Approval policies: human, verification subagent, or independent agent.",
          "Adapter boundary: Codex and OpenClaw run behind a shared interface."
        ].join("\n"),
        options.invokeAgent
      )
      if (designResult.status === "failed") {
        break
      }
      openApprovalGate(nextRun, "design")
      maybeAutoApproveGate(nextRun, "design")
      break
    case "design":
      nextRun.currentStage = "implementation"
      nextRun.status = "running"
      await addAgentArtifact(
        nextRun,
        "implementation.dispatch",
        "implementation",
        "patch",
        "Implementation Plan",
        [
          `Assigned executor: ${resolveSkillExecutor(nextRun, "implementation.dispatch")}`,
          "Runner mode: simulated MVP adapter.",
          "Expected output: branch, commits, PR link, and implementation notes."
        ].join("\n"),
        options.invokeAgent
      )
      break
    case "implementation":
      nextRun.currentStage = "verification"
      nextRun.status = "running"
      const verificationResult = await addAgentArtifact(
        nextRun,
        "verification.generate",
        "verification",
        "test_report",
        "Verification Report",
        [
          "Checks:",
          "- Unit coverage target prepared.",
          "- Acceptance criteria mapped to verification checklist.",
          "- Final gate waits for configured approval actor."
        ].join("\n"),
        options.invokeAgent
      )
      if (verificationResult.status === "failed") {
        break
      }
      openApprovalGate(nextRun, "verification")
      maybeAutoApproveGate(nextRun, "verification")
      break
    case "verification":
      nextRun.currentStage = "completed"
      nextRun.status = "completed"
      addWorkflowEvent(
        nextRun,
        "closeout.archive",
        "completed",
        resolveSkillExecutor(nextRun, "closeout.archive"),
        []
      )
      break
  }

  nextRun.updatedAt = new Date().toISOString()
  return nextRun
}

export function decideApprovalGate(
  run: WorkflowRun,
  gateId: string,
  decision: "approved" | "rejected" | "changes_requested",
  note?: string
): WorkflowRun {
  if (isTerminalStatus(run.status)) {
    return run
  }

  const nextRun = cloneRun(run)
  ensureEventSkillState(nextRun)
  const gate = nextRun.approvalGates.find((item) => item.id === gateId)

  if (!gate || gate.status !== "pending") {
    return nextRun
  }

  gate.status = decision
  gate.decidedAt = new Date().toISOString()
  gate.decidedBy = gate.assignedAgent ?? gate.actorType
  gate.decisionNote = note

  if (decision === "approved") {
    nextRun.status = "running"
    completeApprovalEvent(nextRun, gate.stage, "completed", gate.decidedBy)
  } else if (decision === "changes_requested") {
    nextRun.status = "waiting_for_approval"
    completeApprovalEvent(nextRun, gate.stage, "failed", gate.decidedBy)
  } else {
    nextRun.status = "failed"
    completeApprovalEvent(nextRun, gate.stage, "failed", gate.decidedBy)
  }

  nextRun.updatedAt = new Date().toISOString()
  return nextRun
}

export function cancelWorkflowRun(run: WorkflowRun): WorkflowRun {
  if (isTerminalStatus(run.status)) {
    return run
  }

  const nextRun = cloneRun(run)
  const now = new Date().toISOString()
  ensureEventSkillState(nextRun)

  nextRun.status = "cancelled"
  nextRun.updatedAt = now

  nextRun.approvalGates
    .filter((gate) => gate.status === "pending")
    .forEach((gate) => {
      gate.status = "cancelled"
      gate.decidedAt = now
      gate.decidedBy = "dashboard"
      gate.decisionNote = "Workflow run cancelled from the dashboard."
    })

  nextRun.events
    .filter(
      (event) =>
        event.status === "pending" ||
        event.status === "running" ||
        event.status === "waiting_for_gate"
    )
    .forEach((event) => {
      event.status = "cancelled"
      event.note = "Workflow run cancelled from the dashboard."
      event.completedAt = now
    })

  nextRun.agentRuns
    .filter(
      (agentRun) =>
        agentRun.status === "pending" ||
        agentRun.status === "running" ||
        agentRun.status === "waiting_for_approval"
    )
    .forEach((agentRun) => {
      agentRun.status = "cancelled"
      agentRun.finishedAt = now
    })

  return nextRun
}

function isTerminalStatus(status: WorkflowRun["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function maybeAutoApproveGate(run: WorkflowRun, stage: WorkflowStage) {
  const gate = [...run.approvalGates]
    .reverse()
    .find((item) => item.stage === stage && item.status === "pending")

  if (!gate || gate.actorType === "human") {
    return
  }

  gate.status = "approved"
  gate.decidedAt = new Date().toISOString()
  gate.decidedBy =
    gate.actorType === "independent_agent"
      ? "independent-reviewer"
      : "verification-subagent"
  gate.decisionNote =
    gate.actorType === "independent_agent"
      ? "Approved by an independent reviewer agent."
      : "Approved by the configured verification subagent."
  run.status = "running"
  completeApprovalEvent(run, stage, "completed", gate.decidedBy)
}

function openApprovalGate(run: WorkflowRun, stage: WorkflowStage) {
  const policy = run.approvalPolicies.find((item) => item.stage === stage)
  const gate: ApprovalGate = {
    id: crypto.randomUUID(),
    workflowRunId: run.id,
    stage,
    status: "pending",
    requestedBy: "system",
    actorType: policy?.actorType ?? "human",
    assignedAgent: policy?.agent,
    requireIndependence: policy?.requireIndependence ?? false,
    createdAt: new Date().toISOString()
  }

  run.approvalGates.push(gate)
  run.status = "waiting_for_approval"
  addWorkflowEvent(
    run,
    `${stage}.approval`,
    "waiting_for_gate",
    resolveSkillExecutor(run, `${stage}.approval`),
    [],
    `Gate reviewer policy: ${gate.actorType}.`
  )
}

async function addAgentArtifact(
  run: WorkflowRun,
  skillId: string,
  stage: WorkflowStage,
  type: Artifact["type"],
  title: string,
  body: string,
  invokeAgent?: AgentInvoker
) {
  const executor = resolveSkillExecutor(run, skillId)
  const skill = run.eventSkills.find((item) => item.id === skillId)
  const agentResult =
    skill && invokeAgent
      ? await invokeAgent({
          run,
          skill,
          executor,
          stage,
          artifactType: type,
          title,
          fallbackBody: body
        })
      : undefined
  const finalResult: AgentArtifactResult = agentResult ?? {
    status: "completed",
    source: "simulated",
    body
  }
  const artifact = createArtifact(run.id, stage, type, title, finalResult.body)
  run.artifacts.push(artifact)
  addWorkflowEvent(
    run,
    skillId,
    finalResult.status,
    executor,
    [artifact.id],
    [
      `${title} generated by ${executor}.`,
      `Runner source: ${finalResult.source}.`,
      finalResult.externalRunId ? `External run: ${finalResult.externalRunId}.` : undefined
    ]
      .filter(Boolean)
      .join(" ")
  )
  run.agentRuns.push({
    id: crypto.randomUUID(),
    workflowRunId: run.id,
    stage,
    agent: executor,
    status: finalResult.status,
    inputArtifactIds: run.artifacts.slice(0, -1).map((item) => item.id),
    outputArtifactIds: [artifact.id],
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  })

  if (finalResult.status === "failed") {
    run.status = "failed"
  }

  return finalResult
}

function ensureEventSkillState(run: WorkflowRun) {
  run.eventSkills = run.eventSkills ?? createDefaultEventSkills()
  run.events = run.events ?? []
  run.skillAssignments =
    run.skillAssignments ??
    (Object.fromEntries(
      run.eventSkills.map((skill) => [skill.id, run.selectedAgent])
    ) as Record<string, AgentKind>)
}

function resolveSkillExecutor(run: WorkflowRun, skillId: string): AgentKind {
  return run.skillAssignments?.[skillId] ?? run.selectedAgent
}

function addWorkflowEvent(
  run: WorkflowRun,
  skillId: string,
  status: WorkflowEvent["status"],
  actor: string,
  outputArtifactIds: string[],
  note?: string
) {
  const skill = run.eventSkills.find((item) => item.id === skillId)

  if (!skill) {
    return
  }

  run.events.push(
    createWorkflowEvent({
      workflowRunId: run.id,
      skill,
      status,
      actor,
      inputArtifactIds: run.artifacts.map((item) => item.id),
      outputArtifactIds,
      note
    })
  )
}

function createWorkflowEvent(input: {
  workflowRunId: string
  skill: WorkflowEventSkill
  status: WorkflowEvent["status"]
  actor: string
  inputArtifactIds: string[]
  outputArtifactIds: string[]
  note?: string
}): WorkflowEvent {
  const now = new Date().toISOString()

  return {
    id: crypto.randomUUID(),
    workflowRunId: input.workflowRunId,
    skillId: input.skill.id,
    eventType: input.skill.eventType,
    stage: input.skill.stage,
    status: input.status,
    actor: input.actor,
    inputArtifactIds: input.inputArtifactIds,
    outputArtifactIds: input.outputArtifactIds,
    constraintsSnapshot: input.skill.constraints,
    note: input.note,
    createdAt: now,
    completedAt:
      input.status === "completed" || input.status === "failed" ? now : undefined
  }
}

function completeApprovalEvent(
  run: WorkflowRun,
  stage: WorkflowStage,
  status: "completed" | "failed",
  actor?: string
) {
  const event = [...run.events]
    .reverse()
    .find(
      (item) =>
        item.stage === stage &&
        item.status === "waiting_for_gate" &&
        item.eventType.endsWith("_approval")
    )

  if (!event) {
    return
  }

  event.status = status
  event.note = actor ? `Decision recorded by ${actor}.` : event.note
  event.completedAt = new Date().toISOString()
}

function createArtifact(
  workflowRunId: string,
  stage: WorkflowStage,
  type: Artifact["type"],
  title: string,
  body: string
): Artifact {
  return {
    id: crypto.randomUUID(),
    workflowRunId,
    stage,
    type,
    title,
    body,
    createdAt: new Date().toISOString()
  }
}

function cloneRun(run: WorkflowRun): WorkflowRun {
  return JSON.parse(JSON.stringify(run)) as WorkflowRun
}
