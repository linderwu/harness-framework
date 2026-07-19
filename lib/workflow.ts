import type {
  AgentKind,
  ApprovalActorType,
  ApprovalGate,
  ApprovalPolicy,
  Artifact,
  AgentRunSource,
  ExecutionMode,
  ProjectContextFile,
  WorkflowEvent,
  WorkflowEventSkill,
  WorkflowEventType,
  WorkflowRun,
  WorkflowStage
} from "@/lib/types"
import type { AgentInvocationInput } from "@/lib/agent-bridge"
import { getAgentLabel, normalizeAgentKind, openClawAgentKinds } from "@/lib/agents"

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
  plan_review: "Plan Review",
  plan_approval: "Plan Approval",
  openspec_design: "OpenSpec Design",
  design_approval: "Design Approval",
  implementation_dispatch: "Implementation Dispatch",
  implementation_code_review: "Code Review",
  verification_generate: "Verification Generation",
  implementation_review: "Implementation Review",
  verification_approval: "Verification Approval",
  closeout: "Closeout"
}

export interface AgentArtifactResult {
  status: "completed" | "failed"
  source: AgentRunSource
  body: string
  repository?: string
  externalRunId?: string
  idempotencyKey?: string
  statusMessage?: string
  artifacts?: Array<{ type: string; title: string; body: string }>
  capabilities?: string[]
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
      allowedActors: ["human", "codex", ...openClawAgentKinds],
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
      allowedActors: ["human", "codex", ...openClawAgentKinds],
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
      id: "plan.review",
      eventType: "plan_review",
      stage: "plan",
      name: "Plan Review Skill",
      purpose: "Review the plan for missing scope, weak acceptance criteria, and unresolved blockers before approval.",
      trigger: "A plan draft is generated.",
      allowedActors: ["codex", "independent_agent", ...openClawAgentKinds],
      inputs: ["plan artifact", "requirement artifact", "repository context"],
      outputs: ["plan review report", "blocking findings"],
      constraints: [
        "Review the plan before implementation details are accepted.",
        "Flag vague acceptance criteria and missing user scenarios.",
        "Use severity labels and include `Blocking findings: yes` when HIGH or CRITICAL issues remain."
      ],
      gates: ["Blocking plan review findings return the run to planning."],
      knowledgeSources: ["standard-dev-workflow", "omx_wiki/project-context"],
      verificationRules: [
        "Review report includes severity counts.",
        "Blocking findings are explicit."
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
      allowedActors: ["codex", ...openClawAgentKinds, "human"],
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
      allowedActors: ["codex", ...openClawAgentKinds, "human"],
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
      id: "implementation.code_review",
      eventType: "implementation_code_review",
      stage: "implementation",
      name: "Code Review Skill",
      purpose: "Review the implementation diff for correctness, maintainability, security, and missing tests before runtime verification.",
      trigger: "Implementation output is generated.",
      allowedActors: ["codex", "independent_agent", ...openClawAgentKinds],
      inputs: ["patch artifact", "approved design", "acceptance criteria"],
      outputs: ["code review report", "blocking findings"],
      constraints: [
        "Do not approve code written by the same implementation agent without independent scrutiny.",
        "Prioritize bugs, regressions, security risks, and missing tests.",
        "Use severity labels and include `Blocking findings: yes` when HIGH or CRITICAL issues remain."
      ],
      gates: ["Blocking code review findings return the run to implementation."],
      knowledgeSources: ["standard-dev-workflow", "repository diff", "CI logs"],
      verificationRules: [
        "Review report includes file or artifact references.",
        "HIGH and CRITICAL findings are treated as blocking."
      ]
    },
    {
      id: "verification.implementation_review",
      eventType: "implementation_review",
      stage: "verification",
      name: "Implementation Review Skill",
      purpose: "Exercise key user scenarios end to end and report product-quality findings by severity.",
      trigger: "Code review passes and the implementation enters verification.",
      allowedActors: ["codex", ...openClawAgentKinds, "verification_subagent"],
      inputs: ["patch artifact", "code review report", "acceptance criteria", "test strategy"],
      outputs: ["implementation review report", "scenario logs", "blocking findings"],
      constraints: [
        "Generate scenarios from acceptance criteria and important product flows.",
        "For each scenario, inspect current state, record evidence, decide the next action, and continue until the scenario is complete.",
        "Use Playwright for web apps and simulator-backed tooling for mobile apps when available.",
        "Use severity labels and include `Blocking findings: yes` when HIGH or CRITICAL issues remain."
      ],
      gates: ["Blocking implementation review findings return the run to implementation."],
      knowledgeSources: ["playwright-mcp", "XcodeBuildMCP", "acceptance criteria"],
      verificationRules: [
        "Each scenario records observed behavior.",
        "Findings are grouped by severity."
      ]
    },
    {
      id: "verification.generate",
      eventType: "verification_generate",
      stage: "verification",
      name: "Verification Generation Skill",
      purpose: "Generate and run tests against the implementation and acceptance criteria.",
      trigger: "Implementation review completes.",
      allowedActors: ["codex", ...openClawAgentKinds, "verification_subagent"],
      inputs: ["implementation review report", "patch artifact", "acceptance criteria", "test strategy"],
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
      allowedActors: ["human", "codex", ...openClawAgentKinds],
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

export function getDefaultSkillExecutor(
  skillId: string,
  selectedAgent: AgentKind
): AgentKind {
  if (
    skillId === "plan.review" ||
    skillId === "implementation.code_review" ||
    skillId === "verification.implementation_review"
  ) {
    return "codex"
  }

  return selectedAgent
}

export function createWorkflowRun(input: {
  projectName: string
  repository: string
  requirement: string
  contextFiles?: ProjectContextFile[]
  selectedAgent: AgentKind
  skillAssignments?: Record<string, AgentKind>
  designApprovalActor: ApprovalActorType
  verificationApprovalActor: ApprovalActorType
}): WorkflowRun {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  const eventSkills = createDefaultEventSkills()
  const selectedAgent = normalizeAgentKind(input.selectedAgent)
  const stageModes = Object.fromEntries(
    stages.map((stage) => [stage, stage === "completed" ? "manual" : "hybrid"])
  ) as Record<WorkflowStage, ExecutionMode>
  const skillAssignments = Object.fromEntries(
    eventSkills.map((skill) => [
      skill.id,
      normalizeAgentKind(
        input.skillAssignments?.[skill.id] ??
          getDefaultSkillExecutor(skill.id, selectedAgent)
      )
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
        input.designApprovalActor === "human" ? undefined : selectedAgent,
      requireIndependence: input.designApprovalActor === "independent_agent"
    },
    {
      stage: "verification",
      actorType: input.verificationApprovalActor,
      agent:
        input.verificationApprovalActor === "human"
          ? undefined
          : selectedAgent,
      requireIndependence: input.verificationApprovalActor === "independent_agent"
    }
  ]

  return {
    schemaVersion: 2,
    version: 1,
    id,
    projectName: input.projectName,
    repository: input.repository,
    requirement: input.requirement,
    contextFiles: input.contextFiles ?? [],
    source: "dashboard",
    currentStage: "intake",
    status: "pending",
    selectedAgent,
    stageModes,
    skillAssignments,
    approvalPolicies,
    eventSkills,
    events: [],
    artifacts: [],
    approvalGates: [],
    agentRuns: [],
    revisions: [],
    eventLogStatus: "consistent",
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
      nextRun.status = "running"
      const intakeResult = await addAgentArtifact(
        nextRun,
        "intake.requirement",
        "intake",
        "requirement",
        "Requirement Intake",
        [
          `Project: ${nextRun.projectName}`,
          `Requested repository: ${nextRun.repository || "not requested"}`,
          "Requirement:",
          nextRun.requirement
        ].join("\n"),
        options.invokeAgent
      )
      if (intakeResult.status === "failed") {
        break
      }
      nextRun.currentStage = "plan"
      nextRun.status = "pending"
      break
    case "plan":
      if (hasApprovedGate(nextRun, "plan")) {
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
        nextRun.currentStage = "implementation"
        openApprovalGate(nextRun, "design")
        maybeAutoApproveGate(nextRun, "design")
        break
      }

      const latestPlan = getLatestArtifact(nextRun, "plan", "plan")
      const latestPlanReview = getLatestArtifact(
        nextRun,
        "plan_review_report",
        "plan"
      )

      if (
        !latestPlan ||
        (isArtifactAfter(nextRun, latestPlanReview, latestPlan) &&
          hasBlockingFindings(latestPlanReview?.body ?? ""))
      ) {
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
        markActiveRevisionResubmitted(nextRun, "plan")
        nextRun.status = "pending"
        break
      }

      if (!isArtifactAfter(nextRun, latestPlanReview, latestPlan)) {
        nextRun.status = "running"
        const planReviewResult = await addAgentArtifact(
          nextRun,
          "plan.review",
          "plan",
          "plan_review_report",
          "Plan Review Report",
          [
            "PLAN REVIEW REPORT",
            "Blocking findings: no",
            "CRITICAL (0)",
            "HIGH (0)",
            "MEDIUM (0)",
            "LOW (0)",
            "Recommendation: approve plan for human gate."
          ].join("\n"),
          options.invokeAgent
        )
        if (planReviewResult.status === "failed") {
          break
        }
        if (hasBlockingFindings(planReviewResult.body)) {
          createReviewRevision(
            nextRun,
            "plan",
            "plan",
            "plan.review",
            "Plan review returned blocking findings."
          )
          nextRun.status = "pending"
          break
        }
        resolveActiveRevisions(nextRun, "plan", "accepted")
        openApprovalGate(nextRun, "plan")
        break
      }

      nextRun.status = "running"
      openApprovalGate(nextRun, "plan")
      break
    case "design":
      break
    case "implementation":
      const latestPatch = getLatestArtifact(nextRun, "patch", "implementation")
      const latestCodeReview = getLatestArtifact(
        nextRun,
        "code_review_report",
        "implementation"
      )

      if (
        !latestPatch ||
        (isArtifactAfter(nextRun, latestCodeReview, latestPatch) &&
          hasBlockingFindings(latestCodeReview?.body ?? ""))
      ) {
        nextRun.status = "running"
        const implementationResult = await addAgentArtifact(
          nextRun,
          "implementation.dispatch",
          "implementation",
          "patch",
          "Implementation Plan",
          [
            `Assigned executor: ${getAgentLabel(resolveSkillExecutor(nextRun, "implementation.dispatch"))}`,
            "Runner mode: simulated MVP adapter.",
            "Expected output: branch, commits, PR link, and implementation notes."
          ].join("\n"),
          options.invokeAgent
        )
        if (implementationResult.status === "failed") {
          break
        }
        markActiveRevisionResubmitted(nextRun, "implementation")
        nextRun.status = "pending"
        break
      }

      if (!isArtifactAfter(nextRun, latestCodeReview, latestPatch)) {
        nextRun.status = "running"
        const codeReviewResult = await addAgentArtifact(
          nextRun,
          "implementation.code_review",
          "implementation",
          "code_review_report",
          "Code Review Report",
          [
            "CODE REVIEW REPORT",
            "Blocking findings: no",
            "CRITICAL (0)",
            "HIGH (0)",
            "MEDIUM (0)",
            "LOW (0)",
            "Recommendation: approve for implementation review."
          ].join("\n"),
          options.invokeAgent
        )
        if (codeReviewResult.status === "failed") {
          break
        }
        if (hasBlockingFindings(codeReviewResult.body)) {
          createReviewRevision(
            nextRun,
            "implementation",
            "implementation",
            "implementation.code_review",
            "Code review returned blocking findings."
          )
          nextRun.status = "pending"
          break
        }
        resolveActiveRevisions(nextRun, "implementation", "accepted")
      }

      nextRun.currentStage = "verification"
      nextRun.status = "pending"
      break
    case "verification":
      if (hasApprovedGate(nextRun, "verification")) {
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

      const latestVerifiedPatch = getLatestArtifact(
        nextRun,
        "patch",
        "implementation"
      )
      const latestImplementationReview = getLatestArtifact(
        nextRun,
        "implementation_review_report",
        "verification"
      )

      if (
        latestVerifiedPatch &&
        !isArtifactAfter(
          nextRun,
          latestImplementationReview,
          latestVerifiedPatch
        )
      ) {
        nextRun.status = "running"
        const implementationReviewResult = await addAgentArtifact(
          nextRun,
          "verification.implementation_review",
          "verification",
          "implementation_review_report",
          "Implementation Review Report",
          [
            "IMPLEMENTATION REVIEW REPORT",
            "Blocking findings: no",
            "Scenarios:",
            "- Key acceptance path reviewed.",
            "CRITICAL (0)",
            "HIGH (0)",
            "MEDIUM (0)",
            "LOW (0)",
            "Recommendation: approve for verification report."
          ].join("\n"),
          options.invokeAgent
        )
        if (implementationReviewResult.status === "failed") {
          break
        }
        if (hasBlockingFindings(implementationReviewResult.body)) {
          createReviewRevision(
            nextRun,
            "verification",
            "implementation",
            "verification.implementation_review",
            "Implementation review returned blocking findings."
          )
          nextRun.currentStage = "implementation"
          nextRun.status = "pending"
          break
        }
        nextRun.status = "pending"
        break
      }

      const latestTestReport = getLatestArtifact(
        nextRun,
        "test_report",
        "verification"
      )

      if (
        latestImplementationReview &&
        isArtifactAfter(nextRun, latestTestReport, latestImplementationReview)
      ) {
        openApprovalGate(nextRun, "verification")
        maybeAutoApproveGate(nextRun, "verification")
        break
      }

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
          "- Code review and implementation review completed before final approval.",
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
    case "completed":
      break
  }

  nextRun.updatedAt = new Date().toISOString()
  updateEventLogStatus(nextRun)
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
    resolveRevision(nextRun, gate.revisionId, "accepted")
    completeApprovalEvent(nextRun, gate.stage, "completed", gate.decidedBy)
  } else if (decision === "changes_requested") {
    const revision = createRevision(nextRun, gate, gate.decidedBy, note)
    nextRun.revisions.push(revision)
    nextRun.currentStage = revision.targetStage
    nextRun.status = "running"
    completeApprovalEvent(nextRun, gate.stage, "failed", gate.decidedBy)
  } else {
    nextRun.status = "failed"
    resolveRevision(nextRun, gate.revisionId, "rejected")
    completeApprovalEvent(nextRun, gate.stage, "failed", gate.decidedBy)
  }

  nextRun.updatedAt = new Date().toISOString()
  updateEventLogStatus(nextRun)
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

  updateEventLogStatus(nextRun)
  return nextRun
}

export function stopWorkflowStage(run: WorkflowRun): WorkflowRun {
  if (isTerminalStatus(run.status)) {
    return run
  }

  const nextRun = cloneRun(run)
  const now = new Date().toISOString()
  ensureEventSkillState(nextRun)

  nextRun.status = "stopped"
  nextRun.updatedAt = now

  nextRun.approvalGates
    .filter(
      (gate) =>
        gate.stage === nextRun.currentStage && gate.status === "pending"
    )
    .forEach((gate) => {
      gate.status = "stopped"
      gate.decidedAt = now
      gate.decidedBy = "dashboard"
      gate.decisionNote = "Current workflow stage stopped from the dashboard."
    })

  nextRun.events
    .filter(
      (event) =>
        event.stage === nextRun.currentStage &&
        (event.status === "pending" ||
          event.status === "running" ||
          event.status === "waiting_for_gate")
    )
    .forEach((event) => {
      event.status = "stopped"
      event.note = "Current workflow stage stopped from the dashboard."
      event.completedAt = now
    })

  nextRun.agentRuns
    .filter(
      (agentRun) =>
        agentRun.stage === nextRun.currentStage &&
        (agentRun.status === "pending" ||
          agentRun.status === "running" ||
          agentRun.status === "waiting_for_approval")
    )
    .forEach((agentRun) => {
      agentRun.status = "stopped"
      agentRun.finishedAt = now
    })

  updateEventLogStatus(nextRun)
  return nextRun
}

function isTerminalStatus(status: WorkflowRun["status"]) {
  return status === "completed" || status === "failed" || status === "cancelled"
}

function hasApprovedGate(run: WorkflowRun, stage: WorkflowStage) {
  const latestGate = [...run.approvalGates]
    .reverse()
    .find((gate) => gate.stage === stage)

  return latestGate?.status === "approved"
}

function getLatestArtifact(
  run: WorkflowRun,
  type: Artifact["type"],
  stage?: WorkflowStage
) {
  return [...run.artifacts]
    .reverse()
    .find((artifact) => artifact.type === type && (!stage || artifact.stage === stage))
}

function isArtifactAfter(
  run: WorkflowRun,
  artifact: Artifact | undefined,
  baseline: Artifact | undefined
) {
  if (!artifact) {
    return false
  }

  if (!baseline) {
    return true
  }

  return run.artifacts.indexOf(artifact) > run.artifacts.indexOf(baseline)
}

function hasBlockingFindings(body: string) {
  const explicitBlocking = body.match(
    /blocking findings:\s*(yes|no|true|false)/i
  )

  if (explicitBlocking) {
    return explicitBlocking[1].toLowerCase() === "yes" ||
      explicitBlocking[1].toLowerCase() === "true"
  }

  if (/recommendation:\s*request changes/i.test(body)) {
    return true
  }

  return hasPositiveSeverity(body, "critical") || hasPositiveSeverity(body, "high")
}

function hasPositiveSeverity(body: string, severity: "critical" | "high") {
  const headingMatch = body.match(
    new RegExp(`\\b${severity}\\s*\\((\\d+)\\)`, "i")
  )

  if (headingMatch) {
    return Number(headingMatch[1]) > 0
  }

  const countMatch = body.match(
    new RegExp(`\\b${severity}\\s*:\\s*(\\d+)`, "i")
  )

  if (countMatch) {
    return Number(countMatch[1]) > 0
  }

  return new RegExp(`\\b${severity}\\b`, "i").test(body)
}

function createReviewRevision(
  run: WorkflowRun,
  stage: WorkflowStage,
  targetStage: WorkflowStage,
  requestedBy: string,
  note: string
) {
  run.revisions.push({
    id: crypto.randomUUID(),
    workflowRunId: run.id,
    stage,
    targetStage,
    sourceGateId: `review:${requestedBy}`,
    status: "requested",
    requestedBy,
    note,
    createdAt: new Date().toISOString()
  })
}

function markActiveRevisionResubmitted(run: WorkflowRun, stage: WorkflowStage) {
  const revision = getActiveRevision(run, stage)

  if (!revision || revision.status === "resubmitted") {
    return
  }

  revision.status = "resubmitted"
  revision.resubmittedAt = new Date().toISOString()
}

function resolveActiveRevisions(
  run: WorkflowRun,
  stage: WorkflowStage,
  status: "accepted" | "rejected"
) {
  run.revisions
    .filter(
      (revision) =>
        revision.targetStage === stage &&
        (revision.status === "requested" || revision.status === "resubmitted")
    )
    .forEach((revision) => {
      revision.status = status
      revision.resolvedAt = new Date().toISOString()
    })
}

function createRevision(
  run: WorkflowRun,
  gate: ApprovalGate,
  requestedBy: string | undefined,
  note?: string
) {
  const now = new Date().toISOString()
  const targetStage = getRevisionTargetStage(gate.stage)

  return {
    id: crypto.randomUUID(),
    workflowRunId: run.id,
    stage: gate.stage,
    targetStage,
    sourceGateId: gate.id,
    status: "requested" as const,
    requestedBy: requestedBy ?? gate.actorType,
    note,
    createdAt: now
  }
}

function getRevisionTargetStage(stage: WorkflowStage): WorkflowStage {
  if (stage === "verification") {
    return "implementation"
  }

  return stage
}

function getActiveRevision(run: WorkflowRun, stage: WorkflowStage) {
  return [...run.revisions]
    .reverse()
    .find(
      (revision) =>
        revision.targetStage === stage &&
        (revision.status === "requested" || revision.status === "resubmitted")
    )
}

function resolveRevision(
  run: WorkflowRun,
  revisionId: string | undefined,
  status: "accepted" | "rejected"
) {
  if (!revisionId) {
    return
  }

  const revision = run.revisions.find((item) => item.id === revisionId)

  if (!revision) {
    return
  }

  revision.status = status
  revision.resolvedAt = new Date().toISOString()
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
  resolveRevision(run, gate.revisionId, "accepted")
  completeApprovalEvent(run, stage, "completed", gate.decidedBy)
}

function openApprovalGate(run: WorkflowRun, stage: WorkflowStage) {
  const policy = run.approvalPolicies.find((item) => item.stage === stage)
  const revision = getActiveRevision(run, stage)
  const gate: ApprovalGate = {
    id: crypto.randomUUID(),
    workflowRunId: run.id,
    stage,
    status: "pending",
    requestedBy: "system",
    actorType: policy?.actorType ?? "human",
    assignedAgent: policy?.agent,
    requireIndependence: policy?.requireIndependence ?? false,
    revisionId: revision?.id,
    createdAt: new Date().toISOString()
  }

  if (revision) {
    revision.status = "resubmitted"
    revision.resubmittedAt = gate.createdAt
  }

  run.approvalGates.push(gate)
  run.status = "waiting_for_approval"
  addWorkflowEvent(
    run,
    `${stage}.approval`,
    "waiting_for_gate",
    resolveSkillExecutor(run, `${stage}.approval`),
    [],
    `Gate reviewer policy: ${gate.actorType}.`,
    revision?.id
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
  const revision = getActiveRevision(run, stage)
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
  const inputArtifactIds = run.artifacts.map((item) => item.id)
  const artifact = createArtifact(
    run.id,
    stage,
    type,
    title,
    finalResult.body,
    revision?.id
  )
  const extraArtifacts = (finalResult.artifacts ?? []).map((item) =>
    createArtifact(
      run.id,
      stage,
      normalizeArtifactType(item.type),
      item.title,
      item.body,
      revision?.id
    )
  )
  const outputArtifactIds = [artifact, ...extraArtifacts].map((item) => item.id)
  run.artifacts.push(artifact, ...extraArtifacts)
  if (finalResult.repository) {
    run.repository = finalResult.repository
  }
  addWorkflowEvent(
    run,
    skillId,
    finalResult.status,
    executor,
    outputArtifactIds,
    [
      `${title} generated by ${getAgentLabel(executor)}.`,
      `Runner source: ${finalResult.source}.`,
      finalResult.externalRunId ? `External run: ${finalResult.externalRunId}.` : undefined,
      finalResult.statusMessage,
      revision ? `Revision: ${revision.id}.` : undefined
    ]
      .filter(Boolean)
      .join(" "),
    revision?.id
  )
  run.agentRuns.push({
    id: crypto.randomUUID(),
    workflowRunId: run.id,
    stage,
    agent: executor,
    status: finalResult.status,
    source: finalResult.source,
    externalRunId: finalResult.externalRunId,
    idempotencyKey: finalResult.idempotencyKey,
    statusMessage: finalResult.statusMessage,
    revisionId: revision?.id,
    inputArtifactIds,
    outputArtifactIds,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString()
  })

  if (finalResult.status === "failed") {
    run.status = "failed"
  }

  return finalResult
}

function ensureEventSkillState(run: WorkflowRun) {
  run.schemaVersion = run.schemaVersion ?? 2
  run.version = run.version ?? 1
  run.eventSkills = run.eventSkills ?? createDefaultEventSkills()
  run.events = run.events ?? []
  run.contextFiles = run.contextFiles ?? []
  run.revisions = run.revisions ?? []
  run.eventLogStatus = run.eventLogStatus ?? "consistent"
  const skillAssignments = run.skillAssignments ?? {}
  run.skillAssignments = Object.fromEntries(
    run.eventSkills.map((skill) => [
      skill.id,
      normalizeAgentKind(
        skillAssignments[skill.id] ??
          getDefaultSkillExecutor(skill.id, run.selectedAgent)
      )
    ])
  ) as Record<string, AgentKind>
}

function resolveSkillExecutor(run: WorkflowRun, skillId: string): AgentKind {
  return normalizeAgentKind(run.skillAssignments?.[skillId] ?? run.selectedAgent)
}

function addWorkflowEvent(
  run: WorkflowRun,
  skillId: string,
  status: WorkflowEvent["status"],
  actor: string,
  outputArtifactIds: string[],
  note?: string,
  revisionId?: string
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
      note,
      revisionId
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
  revisionId?: string
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
    revisionId: input.revisionId,
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
  body: string,
  revisionId?: string
): Artifact {
  return {
    id: crypto.randomUUID(),
    workflowRunId,
    stage,
    type,
    title,
    body,
    revisionId,
    createdAt: new Date().toISOString()
  }
}

function normalizeArtifactType(type: string): Artifact["type"] {
  const artifactTypes = new Set<Artifact["type"]>([
    "requirement",
    "plan",
    "plan_review_report",
    "openspec",
    "design",
    "patch",
    "code_review_report",
    "implementation_review_report",
    "test_report",
    "coverage_report",
    "manual_checklist",
    "scenario_log",
    "screenshot",
    "finding",
    "log"
  ])

  return artifactTypes.has(type as Artifact["type"])
    ? (type as Artifact["type"])
    : "log"
}

function updateEventLogStatus(run: WorkflowRun) {
  const artifactIds = new Set(run.artifacts.map((artifact) => artifact.id))
  const missingOutputIds = run.events
    .flatMap((event) => event.outputArtifactIds)
    .filter((artifactId) => !artifactIds.has(artifactId))
  const runScopedEvents = run.events.filter(
    (event) => event.workflowRunId !== run.id
  )

  if (missingOutputIds.length > 0 || runScopedEvents.length > 0) {
    run.eventLogStatus = "drift_detected"
    run.eventLogWarning = [
      missingOutputIds.length > 0
        ? `${missingOutputIds.length} event output reference(s) point at missing artifacts`
        : undefined,
      runScopedEvents.length > 0
        ? `${runScopedEvents.length} event(s) belong to a different workflow run`
        : undefined
    ]
      .filter(Boolean)
      .join("; ")
    return
  }

  run.eventLogStatus = "consistent"
  run.eventLogWarning = undefined
}

function cloneRun(run: WorkflowRun): WorkflowRun {
  return JSON.parse(JSON.stringify(run)) as WorkflowRun
}
