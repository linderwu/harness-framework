import type {
  ArceusMaintenanceConfig,
  ExternalEffect,
  HiveMissionConfig,
  ManagedProjectConfig,
  ManagedRunSummary,
  WorkflowEventSkill
} from "./types"
import type { AgentPermissionMode } from "./agent-permissions"

export const arceusMaintenanceStages: ArceusMaintenanceConfig["stages"] = [
  "Intake", "Plan", "Modify", "Test", "Code Review", "Ready"
]

export function createHiveMissionConfig(input: {
  successCriteria: string[]
  repositoryScope: string
  constraints: string[]
  nonGoals: string[]
  budget: { callLimit: number; timeLimitMs: number; costLimitUsd: number }
}): HiveMissionConfig {
  requireNonEmptyStrings(input.successCriteria, "successCriteria")
  if (!input.repositoryScope.trim()) throw new Error("Hive Mission repositoryScope is required.")
  if (input.budget.callLimit <= 0 || input.budget.timeLimitMs <= 0 || input.budget.costLimitUsd <= 0) {
    throw new Error("Hive Mission budgets must be positive.")
  }
  return {
    kind: "hive_mission",
    manager: "codex",
    successCriteria: cleanStrings(input.successCriteria),
    repositoryScope: input.repositoryScope.trim(),
    constraints: cleanStrings(input.constraints),
    nonGoals: cleanStrings(input.nonGoals),
    budget: input.budget,
    approvalPolicy: "external_and_irreversible"
  }
}

export function createArceusMaintenanceConfig(input: {
  repository: string
  successCriteria: string[]
  constraints: string[]
  nonGoals: string[]
}): ArceusMaintenanceConfig {
  if (!input.repository.trim()) {
    throw new Error(
      "JORMUNGAND_REPOSITORY is required for Arceus Maintenance. Set it in the server environment and redeploy."
    )
  }
  requireNonEmptyStrings(input.successCriteria, "successCriteria")
  return {
    kind: "arceus_maintenance",
    target: "Jormungand",
    executor: "codex",
    repository: input.repository.trim(),
    successCriteria: cleanStrings(input.successCriteria),
    constraints: cleanStrings(input.constraints),
    nonGoals: cleanStrings(input.nonGoals),
    stages: [...arceusMaintenanceStages],
    approvalPolicy: "external_and_irreversible"
  }
}

export function createManagedRunSummary(config: ManagedProjectConfig): ManagedRunSummary {
  const now = new Date().toISOString()
  const budget = config.kind === "hive_mission"
    ? config.budget
    : { callLimit: 20, timeLimitMs: 3_600_000, costLimitUsd: 5 }
  return {
    manager: "codex",
    state: "idle",
    taskCounts: { pending: 0, running: 0, completed: 0, failed: 0, stopped: 0 },
    budget: { ...budget, callsUsed: 0, startedAt: now, costUsedUsd: 0 },
    circuitBreakerOpen: false,
    nextWakeCondition: "mission_created"
  }
}

export function createHiveMissionEventSkills(): WorkflowEventSkill[] {
  return managedSkills("Hive Mission", [
    ["hive.plan", "plan_interview", "plan", "Plan mission task graph"],
    ["hive.dispatch", "implementation_dispatch", "implementation", "Dispatch bounded worker tasks"],
    ["hive.monitor", "implementation_review", "verification", "Evaluate evidence and recover failures"],
    ["hive.closeout", "closeout", "completed", "Verify success criteria and close mission"]
  ])
}

export function createArceusMaintenanceEventSkills(): WorkflowEventSkill[] {
  return managedSkills("Arceus Maintenance", [
    ["arceus.intake", "requirement_intake", "intake", "Capture maintenance goal"],
    ["arceus.plan", "plan_interview", "plan", "Plan the repository change"],
    ["arceus.modify", "implementation_dispatch", "implementation", "Modify Jormungand"],
    ["arceus.test", "verification_generate", "verification", "Run verification"],
    ["arceus.code_review", "implementation_code_review", "verification", "Review the change"],
    ["arceus.ready", "closeout", "completed", "Mark the change ready for human-gated effects"]
  ])
}

export function requiresHumanApproval(
  effect: ExternalEffect,
  mode: AgentPermissionMode
) {
  void effect
  return mode !== "full"
}

function managedSkills(
  prefix: string,
  definitions: Array<[string, WorkflowEventSkill["eventType"], WorkflowEventSkill["stage"], string]>
): WorkflowEventSkill[] {
  return definitions.map(([id, eventType, stage, purpose]) => ({
    id,
    eventType,
    stage,
    name: `${prefix}: ${purpose}`,
    purpose,
    trigger: "The persisted manager task graph reaches this stage.",
    allowedActors: ["codex"],
    inputs: ["manager checkpoint", "bounded context pack"],
    outputs: ["manager decision", "evidence references"],
    constraints: [
      "Jormungand validates every proposed action.",
      "External or irreversible effects require human approval."
    ],
    gates: ["Control-plane policy validation"],
    knowledgeSources: ["hive memory", "workflow state"],
    verificationRules: ["Decision and evidence are persisted."]
  }))
}

function cleanStrings(values: string[]) {
  return values.map((value) => value.trim()).filter(Boolean)
}

function requireNonEmptyStrings(values: string[], name: string) {
  if (!Array.isArray(values) || cleanStrings(values).length === 0) {
    throw new Error(`${name} must include at least one non-empty item.`)
  }
}
