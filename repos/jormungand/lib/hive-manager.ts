import type { ContextPack } from "./context-builder"
import type { HiveMemoryRepository } from "./hive-memory/repository"
import type {
  AgentKind,
  ExternalEffect,
  ManagerAction,
  ManagerCheckpoint,
  ManagerProposal,
  ProposedMemoryChange,
  WorkflowRun
} from "./types"

export interface ManagerAuthority {
  workflowRunId: string
  missionTaskIds: string[]
  allowedAgents: AgentKind[]
  remainingCalls: number
  approvalRequiredEffects: ExternalEffect[]
}

export interface ManagerProposalValidation {
  acceptedActions: ManagerAction[]
  rejectedActions: Array<{ action: unknown; reason: string }>
}

export type HiveManagerInvoker = (input: {
  run: WorkflowRun
  contextPack: ContextPack
  cycle: number
}) => Promise<string>

export function parseManagerProposal(raw: string): ManagerProposal {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error("Manager response must be one valid JSON object.")
  }
  if (!isRecord(parsed)) throw new Error("Manager response must be one valid JSON object.")
  for (const key of ["observation", "decision", "reason", "next_wake_condition"] as const) {
    if (typeof parsed[key] !== "string" || !parsed[key].trim()) throw new Error(`Manager proposal ${key} must be a non-empty string.`)
  }
  if (!Array.isArray(parsed.proposed_actions)) throw new Error("Manager proposal proposed_actions must be an array.")
  if (!Array.isArray(parsed.memory_changes)) throw new Error("Manager proposal memory_changes must be an array.")
  if (!Array.isArray(parsed.approval_requests)) throw new Error("Manager proposal approval_requests must be an array.")

  const proposedActions = parsed.proposed_actions.map(parseManagerAction)
  const memoryChanges = parsed.memory_changes.map(parseMemoryChange)
  const approvalRequests = parsed.approval_requests.map((request) => {
    if (!isRecord(request) || !isExternalEffect(request.effect) || typeof request.reason !== "string") {
      throw new Error("Invalid manager approval request.")
    }
    return {
      effect: request.effect,
      reason: request.reason,
      taskId: typeof request.taskId === "string" ? request.taskId : undefined
    }
  })
  return {
    observation: parsed.observation as string,
    decision: parsed.decision as string,
    reason: parsed.reason as string,
    proposed_actions: proposedActions,
    memory_changes: memoryChanges,
    approval_requests: approvalRequests,
    next_wake_condition: parsed.next_wake_condition as string
  }
}

export function validateManagerProposal(
  proposal: ManagerProposal,
  authority: ManagerAuthority
): ManagerProposalValidation {
  const acceptedActions: ManagerAction[] = []
  const rejectedActions: Array<{ action: unknown; reason: string }> = []
  let dispatchesAccepted = 0

  for (const action of proposal.proposed_actions) {
    const taskId = "taskId" in action ? action.taskId : undefined
    if (taskId && !authority.missionTaskIds.includes(taskId)) {
      rejectedActions.push({ action, reason: "Task is outside the current mission scope." })
      continue
    }
    const agentId = action.type === "dispatch_task" || action.type === "reassign_task"
      ? action.agentId
      : action.type === "request_review" ? action.reviewer : undefined
    if (agentId && !authority.allowedAgents.includes(agentId)) {
      rejectedActions.push({ action, reason: `Agent ${agentId} is not allowed for this mission.` })
      continue
    }
    const consumesCall = action.type === "dispatch_task" || action.type === "retry_task" || action.type === "request_review"
    if (consumesCall && dispatchesAccepted >= authority.remainingCalls) {
      rejectedActions.push({ action, reason: "Mission call budget is exhausted." })
      continue
    }
    if (action.type === "request_approval" && !authority.approvalRequiredEffects.includes(action.effect)) {
      rejectedActions.push({ action, reason: `Effect ${action.effect} is not part of this mission approval policy.` })
      continue
    }
    acceptedActions.push(action)
    if (consumesCall) dispatchesAccepted += 1
  }
  return { acceptedActions, rejectedActions }
}

export class HiveManagerRuntime {
  constructor(private readonly repository: HiveMemoryRepository) {}

  async checkpoint(input: {
    workflowRunId: string
    proposal: ManagerProposal
    validation: ManagerProposalValidation
    checkpoint: ManagerCheckpoint
  }) {
    return this.repository.saveManagerCycle({
      workflowRunId: input.workflowRunId,
      proposal: input.proposal,
      acceptedActions: input.validation.acceptedActions,
      rejectedActions: input.validation.rejectedActions,
      checkpoint: input.checkpoint
    })
  }

  resume(workflowRunId: string) {
    return this.repository.getLatestManagerCheckpoint(workflowRunId)
  }
}

export function createHiveManagerRuntime(repository: HiveMemoryRepository) {
  return new HiveManagerRuntime(repository)
}

function parseManagerAction(value: unknown): ManagerAction {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid manager action.")
  switch (value.type) {
    case "create_task":
      requireStrings(value, ["title", "instruction", "strategy"])
      if (!isStringArray(value.successCriteria)) throw new Error("create_task successCriteria must be a string array.")
      return { type: value.type, title: value.title as string, instruction: value.instruction as string, successCriteria: value.successCriteria, strategy: value.strategy as string }
    case "dispatch_task":
      requireStrings(value, ["taskId", "agentId"])
      return { type: value.type, taskId: value.taskId as string, agentId: value.agentId as AgentKind }
    case "retry_task":
      requireStrings(value, ["taskId", "strategy"])
      return { type: value.type, taskId: value.taskId as string, strategy: value.strategy as string }
    case "reassign_task":
      requireStrings(value, ["taskId", "agentId", "reason"])
      return { type: value.type, taskId: value.taskId as string, agentId: value.agentId as AgentKind, reason: value.reason as string }
    case "pause_task":
    case "stop_task":
      requireStrings(value, ["taskId", "reason"])
      return { type: value.type, taskId: value.taskId as string, reason: value.reason as string }
    case "request_review":
      requireStrings(value, ["taskId", "reviewer"])
      if (value.independent !== true) throw new Error("Manager review must be independent.")
      return { type: value.type, taskId: value.taskId as string, reviewer: value.reviewer as AgentKind, independent: true }
    case "request_approval":
      if (!isExternalEffect(value.effect) || typeof value.reason !== "string") throw new Error("Invalid manager approval action.")
      return { type: value.type, effect: value.effect, reason: value.reason }
    default:
      throw new Error(`Unknown manager action: ${value.type}.`)
  }
}

function parseMemoryChange(value: unknown): ProposedMemoryChange {
  if (!isRecord(value) || typeof value.type !== "string") throw new Error("Invalid manager memory change.")
  switch (value.type) {
    case "promote_candidate":
      requireStrings(value, ["candidateId"])
      return { type: value.type, candidateId: value.candidateId as string }
    case "supersede":
      requireStrings(value, ["memoryId", "replacementCandidateId"])
      return { type: value.type, memoryId: value.memoryId as string, replacementCandidateId: value.replacementCandidateId as string }
    case "retract":
    case "expire":
      requireStrings(value, ["memoryId", "reason"])
      return { type: value.type, memoryId: value.memoryId as string, reason: value.reason as string }
    default:
      throw new Error(`Unknown manager memory change: ${value.type}.`)
  }
}

function requireStrings(value: Record<string, unknown>, keys: string[]) {
  if (keys.some((key) => typeof value[key] !== "string" || !(value[key] as string).trim())) {
    throw new Error(`Manager action requires non-empty fields: ${keys.join(", ")}.`)
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim().length > 0)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isExternalEffect(value: unknown): value is ExternalEffect {
  return [
    "physical_delete", "protected_push", "merge", "production_deploy",
    "paid_operation", "external_message", "other_irreversible"
  ].includes(String(value))
}
