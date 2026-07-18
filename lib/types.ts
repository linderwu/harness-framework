export type WorkflowStatus =
  | "pending"
  | "running"
  | "waiting_for_approval"
  | "failed"
  | "completed"

export type WorkflowStage =
  | "intake"
  | "plan"
  | "design"
  | "implementation"
  | "verification"
  | "completed"

export type ExecutionMode = "manual" | "agent" | "hybrid"

export type AgentKind = "codex" | "openclaw" | "manual"

export type ApprovalActorType =
  | "human"
  | "verification_subagent"
  | "independent_agent"

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "changes_requested"

export type WorkflowEventStatus =
  | "pending"
  | "running"
  | "waiting_for_gate"
  | "completed"
  | "failed"

export type WorkflowEventType =
  | "requirement_intake"
  | "plan_interview"
  | "plan_approval"
  | "openspec_design"
  | "design_approval"
  | "implementation_dispatch"
  | "verification_generate"
  | "verification_approval"
  | "closeout"

export type ArtifactType =
  | "requirement"
  | "plan"
  | "openspec"
  | "design"
  | "patch"
  | "test_report"
  | "coverage_report"
  | "manual_checklist"
  | "log"

export interface ApprovalPolicy {
  stage: WorkflowStage
  actorType: ApprovalActorType
  agent?: AgentKind
  requireIndependence: boolean
}

export interface WorkflowEventSkill {
  id: string
  eventType: WorkflowEventType
  stage: WorkflowStage
  name: string
  purpose: string
  trigger: string
  allowedActors: Array<AgentKind | ApprovalActorType>
  inputs: string[]
  outputs: string[]
  constraints: string[]
  gates: string[]
  knowledgeSources: string[]
  verificationRules: string[]
}

export interface WorkflowEvent {
  id: string
  workflowRunId: string
  skillId: string
  eventType: WorkflowEventType
  stage: WorkflowStage
  status: WorkflowEventStatus
  actor: string
  inputArtifactIds: string[]
  outputArtifactIds: string[]
  constraintsSnapshot: string[]
  note?: string
  createdAt: string
  completedAt?: string
}

export interface Artifact {
  id: string
  workflowRunId: string
  stage: WorkflowStage
  type: ArtifactType
  title: string
  body: string
  createdAt: string
}

export interface ApprovalGate {
  id: string
  workflowRunId: string
  stage: WorkflowStage
  status: ApprovalStatus
  requestedBy: "system" | "agent" | "human"
  actorType: ApprovalActorType
  assignedAgent?: AgentKind
  requireIndependence: boolean
  decidedBy?: string
  decisionNote?: string
  createdAt: string
  decidedAt?: string
}

export interface AgentRun {
  id: string
  workflowRunId: string
  stage: WorkflowStage
  agent: AgentKind
  status: WorkflowStatus
  inputArtifactIds: string[]
  outputArtifactIds: string[]
  startedAt?: string
  finishedAt?: string
}

export interface WorkflowRun {
  id: string
  projectName: string
  repository: string
  requirement: string
  source: "dashboard" | "github_issue" | "github_pr"
  sourceRef?: string
  currentStage: WorkflowStage
  status: WorkflowStatus
  selectedAgent: AgentKind
  stageModes: Record<WorkflowStage, ExecutionMode>
  skillAssignments: Record<string, AgentKind>
  approvalPolicies: ApprovalPolicy[]
  eventSkills: WorkflowEventSkill[]
  events: WorkflowEvent[]
  artifacts: Artifact[]
  approvalGates: ApprovalGate[]
  agentRuns: AgentRun[]
  createdAt: string
  updatedAt: string
}

export interface HarnessState {
  workflowRuns: WorkflowRun[]
}
