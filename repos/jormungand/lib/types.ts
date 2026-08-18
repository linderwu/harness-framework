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

export type ProjectType =
  | "research"
  | "development"
  | "testing"
  | "documentation"
  | "diagnosis"
  | "decision"
  | "llm_wiki_maintenance"
  | "agent_task"
  | "hive_mission"
  | "arceus_maintenance"

export interface MissionBudget {
  callLimit: number
  callsUsed: number
  timeLimitMs: number
  startedAt: string
  costLimitUsd: number
  costUsedUsd: number
}

export type ExternalEffect =
  | "physical_delete"
  | "protected_push"
  | "merge"
  | "production_deploy"
  | "paid_operation"
  | "external_message"
  | "other_irreversible"

export type ManagerAction =
  | { type: "create_task"; title: string; instruction: string; successCriteria: string[]; strategy: string }
  | { type: "dispatch_task"; taskId: string; agentId: AgentKind }
  | { type: "retry_task"; taskId: string; strategy: string }
  | { type: "reassign_task"; taskId: string; agentId: AgentKind; reason: string }
  | { type: "pause_task"; taskId: string; reason: string }
  | { type: "stop_task"; taskId: string; reason: string }
  | { type: "request_review"; taskId: string; reviewer: AgentKind; independent: true }
  | { type: "request_approval"; effect: ExternalEffect; reason: string }

export type ProposedMemoryChange =
  | { type: "promote_candidate"; candidateId: string }
  | { type: "supersede"; memoryId: string; replacementCandidateId: string }
  | { type: "retract"; memoryId: string; reason: string }
  | { type: "expire"; memoryId: string; reason: string }

export interface ManagerApprovalRequest {
  effect: ExternalEffect
  reason: string
  taskId?: string
}

export interface ManagerProposal {
  observation: string
  decision: string
  reason: string
  proposed_actions: ManagerAction[]
  memory_changes: ProposedMemoryChange[]
  approval_requests: ManagerApprovalRequest[]
  next_wake_condition: string
}

export interface ManagerTaskSnapshot {
  id: string
  title: string
  status: "pending" | "running" | "completed" | "failed" | "stopped"
  assignedAgent?: AgentKind
  strategy: string
  attemptCount: number
}

export interface ManagerCheckpoint {
  currentGoal: string
  taskGraph: ManagerTaskSnapshot[]
  workerAssignments: Array<{ taskId: string; agentId: AgentKind; reason?: string }>
  blockers: string[]
  risks: string[]
  recentDecisions: string[]
  pendingApprovals: ManagerApprovalRequest[]
  memoryMutations: ProposedMemoryChange[]
  budget: MissionBudget
  nextWakeCondition: string
}

export interface ManagedRunSummary {
  manager: "codex"
  state: "idle" | "running" | "paused" | "blocked" | "waiting_for_approval" | "completed"
  checkpointId?: string
  taskCounts: Record<"pending" | "running" | "completed" | "failed" | "stopped", number>
  budget: MissionBudget
  nextWakeCondition?: string
  circuitBreakerOpen: boolean
}

export interface HiveMissionConfig {
  kind: "hive_mission"
  manager: "codex"
  successCriteria: string[]
  repositoryScope: string
  constraints: string[]
  nonGoals: string[]
  budget: { callLimit: number; timeLimitMs: number; costLimitUsd: number }
  approvalPolicy: "external_and_irreversible"
}

export interface ArceusMaintenanceConfig {
  kind: "arceus_maintenance"
  target: "Jormungand"
  executor: "codex"
  repository: string
  successCriteria: string[]
  constraints: string[]
  nonGoals: string[]
  stages: ["Intake", "Plan", "Modify", "Test", "Code Review", "Ready"]
  approvalPolicy: "external_and_irreversible"
}

export type ManagedProjectConfig = HiveMissionConfig | ArceusMaintenanceConfig

export type ProjectStatus =
  | "active"
  | "waiting_for_approval"
  | "stopped"
  | "failed"
  | "cancelled"
  | "completed"

export type OpenClawMainAgent =
  | "rowlet"
  | "roaringmoon"
  | "charizard"
  | "mrmime"
  | "gengar"

export type AgentKind =
  | "codex"
  | `openclaw.${OpenClawMainAgent}`

export type CodexReasoningIntensity = "low" | "medium" | "high" | "auto"

export interface CodexExecutionProfile {
  modelId?: string
  reasoningIntensity?: CodexReasoningIntensity
}

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
  | "research_prompt"
  | "research_execute"
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
  | "research_prompt"
  | "research_report"
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

export type RuntimeSkillChecksumAlgorithm = "sha256"

export interface RuntimeSkillChecksum {
  algorithm: RuntimeSkillChecksumAlgorithm
  value: string
}

export interface RuntimeSkillBundleDescriptor {
  id: string
  version: string
  sourceUrl: string
  checksum: RuntimeSkillChecksum
  required: boolean
}

export type RuntimeSkillCacheStatus = "hit" | "miss" | "refreshed"

export interface RuntimeSkillBundleResult {
  id: string
  version: string
  checksum: RuntimeSkillChecksum
  downloadSource: "github-release" | "cache" | "unknown"
  cacheStatus: RuntimeSkillCacheStatus
  verified: boolean
  installedPath?: string
  errorCode?: string
  errorMessage?: string
}

export type RuntimeSkillResolutionErrorCode =
  | "resolution_failed"
  | "registry_not_found"
  | "lockfile_not_found"
  | "bundle_not_in_registry"
  | "bundle_not_locked"
  | "lockfile_registry_mismatch"
  | "runtime_skill_protocol_unsupported"

export interface RuntimeSkillResolutionSuccess {
  status: "completed"
  bundles: RuntimeSkillBundleDescriptor[]
}

export interface RuntimeSkillResolutionFailure {
  status: "failed"
  errorCode: RuntimeSkillResolutionErrorCode
  errorMessage: string
}

export type RuntimeSkillResolution =
  | RuntimeSkillResolutionSuccess
  | RuntimeSkillResolutionFailure

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
  runtimeSkillBundles?: string[]
  superpowerSkill?: {
    id: string
    content: string
    commitSha: string
  }
}

export interface WorkflowCustomStage {
  id: string
  name: string
  skillId: string
  agent: AgentKind
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

export interface Project {
  id: string
  name: string
  type: ProjectType
  goal: string
  status: ProjectStatus
  currentPhase: string
  nextAction: string
  repository: string
  source: "dashboard" | "github_issue" | "github_pr"
  sourceRef?: string
  contextFiles: ProjectContextFile[]
  managedConfig?: ManagedProjectConfig
  artifactIds: string[]
  workflowRunIds: string[]
  createdAt: string
  updatedAt: string
}

export interface ProjectTemplate {
  type: ProjectType
  label: string
  phases: string[]
  defaultArtifacts: ArtifactType[]
  creationPrompts: string[]
  defaultNextAction: string
  warning?: string
}

export interface ProjectOverview {
  project: Project
  phaseLabels: string[]
  artifacts: Artifact[]
  pendingGates: ApprovalGate[]
  agentRuns: AgentRun[]
  workflowEvents: WorkflowEvent[]
  contextFiles: ProjectContextFile[]
  latestRun?: WorkflowRun
  warning?: string
}

export interface WorkspaceWarning {
  code:
    | "legacy_project_created"
    | "unknown_project_type"
    | "missing_project_for_run"
    | "missing_project_artifact_reference"
  message: string
  projectId?: string
  workflowRunId?: string
  artifactId?: string
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
  projectId: string
  projectName: string
  projectType?: ProjectType
  repository: string
  requirement: string
  contextFiles: ProjectContextFile[]
  managedConfig?: ManagedProjectConfig
  source: "dashboard" | "github_issue" | "github_pr"
  sourceRef?: string
  currentStage: WorkflowStage
  status: WorkflowStatus
  selectedAgent: AgentKind
  selectedModelId?: string
  selectedReasoningIntensity?: CodexReasoningIntensity
  stageModes: Record<WorkflowStage, ExecutionMode>
  skillAssignments: Record<string, AgentKind>
  customStages?: WorkflowCustomStage[]
  customStageIndex?: number
  skillExecutionProfiles?: Record<string, CodexExecutionProfile>
  approvalPolicies: ApprovalPolicy[]
  eventSkills: WorkflowEventSkill[]
  events: WorkflowEvent[]
  artifacts: Artifact[]
  approvalGates: ApprovalGate[]
  agentRuns: AgentRun[]
  revisions: WorkflowRevision[]
  eventLogStatus: EventLogStatus
  eventLogWarning?: string
  managed?: ManagedRunSummary
  createdAt: string
  updatedAt: string
}

export interface HarnessState {
  schemaVersion: number
  projects: Project[]
  workflowRuns: WorkflowRun[]
  warnings?: WorkspaceWarning[]
}
