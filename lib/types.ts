export type WorkflowStatus =
  | "pending"
  | "running"
  | "waiting_for_approval"
  | "stopped"
  | "failed"
  | "cancelled"
  | "completed"

export type WorkflowStage =
  | "intake"
  | "plan"
  | "design"
  | "implementation"
  | "verification"
  | "completed"

export type ExecutionMode = "manual" | "agent" | "hybrid"

export type OpenClawMainAgent = "rowlet" | "roaringmoon" | "charizard"

export type AgentKind =
  | "codex"
  | `openclaw.${OpenClawMainAgent}`
  | "manual"

export type ApprovalActorType =
  | "human"
  | "verification_subagent"
  | "independent_agent"

export type ApprovalStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "stopped"
  | "cancelled"
  | "changes_requested"

export type WorkflowEventStatus =
  | "pending"
  | "running"
  | "waiting_for_gate"
  | "completed"
  | "stopped"
  | "cancelled"
  | "failed"

export type WorkflowEventType =
  | "requirement_intake"
  | "plan_interview"
  | "plan_review"
  | "plan_approval"
  | "openspec_design"
  | "design_approval"
  | "implementation_dispatch"
  | "implementation_code_review"
  | "verification_generate"
  | "implementation_review"
  | "verification_approval"
  | "closeout"

export type ArtifactType =
  | "requirement"
  | "plan"
  | "plan_review_report"
  | "openspec"
  | "design"
  | "patch"
  | "code_review_report"
  | "implementation_review_report"
  | "test_report"
  | "coverage_report"
  | "manual_checklist"
  | "scenario_log"
  | "screenshot"
  | "finding"
  | "log"

export type AgentRunSource =
  | "simulated"
  | "codex-bridge"
  | "openclaw-bridge"
  | "openclaw-a2a"

export type RevisionStatus =
  | "requested"
  | "resubmitted"
  | "accepted"
  | "rejected"

export type EventLogStatus = "consistent" | "drift_detected"

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
  revisionId?: string
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
  revisionId?: string
  createdAt: string
}

export interface ProjectContextFile {
  id: string
  name: string
  path: string
  type: string
  size: number
  encoding: "text" | "base64"
  content: string
  importedAt: string
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
  revisionId?: string
  decidedBy?: string
  decisionNote?: string
  createdAt: string
  decidedAt?: string
}

export interface WorkflowRevision {
  id: string
  workflowRunId: string
  stage: WorkflowStage
  targetStage: WorkflowStage
  sourceGateId: string
  status: RevisionStatus
  requestedBy: string
  note?: string
  createdAt: string
  resubmittedAt?: string
  resolvedAt?: string
}

export interface AgentRun {
  id: string
  workflowRunId: string
  stage: WorkflowStage
  agent: AgentKind
  status: WorkflowStatus
  source?: AgentRunSource
  externalRunId?: string
  idempotencyKey?: string
  statusMessage?: string
  revisionId?: string
  inputArtifactIds: string[]
  outputArtifactIds: string[]
  startedAt?: string
  finishedAt?: string
}

export interface WorkflowRun {
  schemaVersion: number
  version: number
  id: string
  projectName: string
  repository: string
  requirement: string
  contextFiles: ProjectContextFile[]
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
  revisions: WorkflowRevision[]
  eventLogStatus: EventLogStatus
  eventLogWarning?: string
  createdAt: string
  updatedAt: string
}

export interface HarnessState {
  workflowRuns: WorkflowRun[]
}
