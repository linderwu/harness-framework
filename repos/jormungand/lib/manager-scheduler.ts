import { estimateTokens, type ContextPack } from "./context-builder"
import {
  getAgentPermissionMode,
  type AgentPermissionMode
} from "./agent-permissions"
import { parseManagerProposal, validateManagerProposal, type HiveManagerInvoker } from "./hive-manager"
import type { HiveMemoryRepository } from "./hive-memory/repository"
import type { AgentKind, ManagerAction, ManagerCheckpoint, WorkflowRun } from "./types"

export type ManagerWakeReason =
  | "mission_created" | "mission_amended" | "worker_completed"
  | "worker_failed" | "worker_timed_out" | "worker_unreachable"
  | "review_blocked" | "memory_candidate" | "memory_conflict"
  | "approval_decided" | "health_check" | "operator_message"
  | "operator_resume" | "worker_message"

export type ManagerCycleResult =
  | { status: "completed"; checkpointId: string; acceptedActionCount: number; rejectedActionCount: number }
  | { status: "paused"; reason: "budget_exhausted" | "operator_paused" | "circuit_breaker" }
  | { status: "idle"; reason: "no_pending_wake" }

type ManagerTask = ReturnType<HiveMemoryRepository["listManagerTasks"]>[number]

export interface ManagerSchedulerDependencies {
  repository: HiveMemoryRepository
  getRun: (id: string) => Promise<WorkflowRun | undefined>
  saveRun: (run: WorkflowRun) => Promise<WorkflowRun>
  invokeManager: HiveManagerInvoker
  allowedAgents: (run: WorkflowRun) => AgentKind[]
  permissionMode?: AgentPermissionMode
  dispatchWorker?: (input: {
    run: WorkflowRun
    task: ManagerTask
    agentId: AgentKind
    idempotencyKey: string
  }) => Promise<{ status: "completed" | "failed"; body: string }>
  requestApproval?: (input: { run: WorkflowRun; action: Extract<ManagerAction, { type: "request_approval" }> }) => Promise<void>
}

const runLocks = new Map<string, Promise<ManagerCycleResult>>()

export class ManagerScheduler {
  constructor(private readonly dependencies: ManagerSchedulerDependencies) {}

  async enqueue(input: { workflowRunId: string; reason: ManagerWakeReason; idempotencyKey: string }) {
    await this.dependencies.repository.enqueueManagerWake(input)
  }

  runNext(workflowRunId: string): Promise<ManagerCycleResult> {
    const previous = runLocks.get(workflowRunId)
    if (previous) return previous
    const current = this.executeNext(workflowRunId).finally(() => {
      if (runLocks.get(workflowRunId) === current) runLocks.delete(workflowRunId)
    })
    runLocks.set(workflowRunId, current)
    return current
  }

  async pause(workflowRunId: string, actor: string) {
    const run = await this.requireManagedRun(workflowRunId)
    const next = await this.dependencies.saveRun({
      ...run,
      managed: { ...run.managed!, state: "paused", nextWakeCondition: "operator_resume" },
      updatedAt: new Date().toISOString()
    })
    await this.dependencies.repository.appendEvent({
      eventType: "manager_paused", actor, workflowRunId,
      payload: { reason: "operator_paused" }
    })
    return next
  }

  private async executeNext(workflowRunId: string): Promise<ManagerCycleResult> {
    let run = await this.requireManagedRun(workflowRunId)
    const wake = this.dependencies.repository.getNextPendingManagerWake(workflowRunId)
    if (!wake) return { status: "idle", reason: "no_pending_wake" }
    if (run.managed!.state === "paused" && wake.reason !== "operator_resume") {
      return { status: "paused", reason: "operator_paused" }
    }
    if (run.managed!.circuitBreakerOpen) return { status: "paused", reason: "circuit_breaker" }
    if (budgetExhausted(run)) {
      run = await this.dependencies.saveRun({
        ...run,
        status: "waiting_for_approval",
        managed: { ...run.managed!, state: "paused", nextWakeCondition: "budget_amended" },
        updatedAt: new Date().toISOString()
      })
      return { status: "paused", reason: "budget_exhausted" }
    }

    await this.dependencies.repository.markManagerWake(wake.id, "processing")
    const tasks = this.dependencies.repository.listManagerTasks(workflowRunId)
    const contextPack = buildManagerContextPack(run, tasks, wake.reason)
    const callsUsed = run.managed!.budget.callsUsed + 1
    run = await this.dependencies.saveRun({
      ...run,
      status: "running",
      managed: {
        ...run.managed!,
        state: "running",
        budget: { ...run.managed!.budget, callsUsed }
      },
      updatedAt: new Date().toISOString()
    })

    const rawProposal = await this.dependencies.invokeManager({
      run,
      contextPack,
      cycle: (this.dependencies.repository.getLatestManagerCheckpoint(workflowRunId)?.cycle ?? 0) + 1
    })
    const proposal = parseManagerProposal(rawProposal)
    const validation = validateManagerProposal(proposal, {
      workflowRunId,
      missionTaskIds: tasks.map((task) => task.id),
      allowedAgents: this.dependencies.allowedAgents(run),
      remainingCalls: Math.max(0, run.managed!.budget.callLimit - callsUsed),
      approvalRequiredEffects: [
        "physical_delete", "protected_push", "merge", "production_deploy",
        "paid_operation", "external_message", "other_irreversible"
      ]
    })
    const application = await this.applyActions(run, validation.acceptedActions)
    const allRejected = [...validation.rejectedActions, ...application.rejectedActions]
    const currentTasks = this.dependencies.repository.listManagerTasks(workflowRunId)
    const checkpoint: ManagerCheckpoint = {
      currentGoal: run.requirement,
      taskGraph: currentTasks.map((task) => ({
        id: task.id,
        title: task.title,
        status: task.status,
        assignedAgent: task.assignedAgent as AgentKind | undefined,
        strategy: task.strategy,
        attemptCount: task.attemptCount
      })),
      workerAssignments: currentTasks
        .filter((task) => task.assignedAgent)
        .map((task) => ({ taskId: task.id, agentId: task.assignedAgent as AgentKind })),
      blockers: currentTasks.filter((task) => task.status === "failed").map((task) => task.lastError ?? `${task.title} failed.`),
      risks: [],
      recentDecisions: [proposal.decision],
      pendingApprovals: proposal.approval_requests,
      memoryMutations: proposal.memory_changes,
      budget: run.managed!.budget,
      nextWakeCondition: proposal.next_wake_condition
    }
    const saved = await this.dependencies.repository.saveManagerCycle({
      workflowRunId,
      proposal,
      acceptedActions: application.appliedActions,
      rejectedActions: allRejected,
      checkpoint
    })
    await this.dependencies.repository.markManagerWake(wake.id, "processed")
    const taskCounts = countTasks(currentTasks)
    const missionCompleted = currentTasks.length > 0 &&
      taskCounts.pending === 0 && taskCounts.running === 0 &&
      taskCounts.failed === 0 && proposal.next_wake_condition === "mission_completed"
    await this.dependencies.saveRun({
      ...run,
      status: application.waitingForApproval ? "waiting_for_approval" : missionCompleted ? "completed" : "pending",
      managed: {
        ...run.managed!,
        state: application.waitingForApproval ? "waiting_for_approval" : missionCompleted ? "completed" : "idle",
        checkpointId: saved.id,
        taskCounts,
        nextWakeCondition: proposal.next_wake_condition
      },
      updatedAt: new Date().toISOString()
    })
    return {
      status: "completed",
      checkpointId: saved.id,
      acceptedActionCount: application.appliedActions.length,
      rejectedActionCount: allRejected.length
    }
  }

  private async applyActions(run: WorkflowRun, actions: ManagerAction[]) {
    const appliedActions: ManagerAction[] = []
    const rejectedActions: Array<{ action: unknown; reason: string }> = []
    let waitingForApproval = false
    const permissionMode = getAgentPermissionMode(
      this.dependencies.permissionMode
    )

    for (const action of actions) {
      if (action.type === "create_task") {
        await this.dependencies.repository.createManagerTask({
          workflowRunId: run.id,
          title: action.title,
          instruction: action.instruction,
          successCriteria: action.successCriteria,
          strategy: action.strategy
        })
        appliedActions.push(action)
        continue
      }
      if (action.type === "request_approval") {
        appliedActions.push(action)
        if (permissionMode !== "full") {
          await this.dependencies.requestApproval?.({ run, action })
          waitingForApproval = true
        }
        continue
      }
      const task = this.dependencies.repository.listManagerTasks(run.id).find((item) => item.id === action.taskId)
      if (!task) {
        rejectedActions.push({ action, reason: "Task disappeared before action application." })
        continue
      }
      if (action.type === "retry_task") {
        if (task.attemptCount >= 2 && action.strategy === task.strategy) {
          rejectedActions.push({ action, reason: "A third attempt must change strategy, reassign, or stop." })
          continue
        }
        await this.dependencies.repository.updateManagerTask({
          id: task.id, status: "pending", strategy: action.strategy,
          incrementAttempt: true
        })
        appliedActions.push(action)
        continue
      }
      if (action.type === "pause_task" || action.type === "stop_task") {
        await this.dependencies.repository.updateManagerTask({
          id: task.id, status: action.type === "stop_task" ? "stopped" : "pending"
        })
        appliedActions.push(action)
        continue
      }
      const agentId = action.type === "request_review" ? action.reviewer : action.agentId
      if (action.type === "reassign_task") {
        await this.dependencies.repository.updateManagerTask({ id: task.id, assignedAgent: agentId, status: "pending" })
        appliedActions.push(action)
        continue
      }
      if (!this.dependencies.dispatchWorker) {
        await this.dependencies.repository.updateManagerTask({ id: task.id, assignedAgent: agentId, status: "running", incrementAttempt: true })
        appliedActions.push(action)
        continue
      }
      await this.dependencies.repository.updateManagerTask({ id: task.id, assignedAgent: agentId, status: "running", incrementAttempt: true })
      const refreshed = this.dependencies.repository.listManagerTasks(run.id).find((item) => item.id === task.id)!
      const result = await this.dependencies.dispatchWorker({
        run, task: refreshed, agentId,
        idempotencyKey: `task:${task.id}:attempt:${refreshed.attemptCount}`
      })
      await this.dependencies.repository.updateManagerTask({
        id: task.id,
        status: result.status,
        lastError: result.status === "failed" ? result.body : undefined
      })
      await this.enqueue({
        workflowRunId: run.id,
        reason: result.status === "completed" ? "worker_completed" : "worker_failed",
        idempotencyKey: `task-result:${task.id}:${refreshed.attemptCount}`
      })
      appliedActions.push(action)
    }
    return { appliedActions, rejectedActions, waitingForApproval }
  }

  private async requireManagedRun(workflowRunId: string) {
    const run = await this.dependencies.getRun(workflowRunId)
    if (!run) throw new Error(`Workflow run ${workflowRunId} not found.`)
    if (!run.managed) throw new Error(`Workflow run ${workflowRunId} is not manager-controlled.`)
    return run
  }
}

export function createManagerScheduler(dependencies: ManagerSchedulerDependencies) {
  return new ManagerScheduler(dependencies)
}

function buildManagerContextPack(run: WorkflowRun, tasks: ManagerTask[], wakeReason: string): ContextPack {
  const text = [
    `Goal: ${run.requirement}`,
    `Wake reason: ${wakeReason}`,
    `Status: ${run.status}`,
    `Budget: ${JSON.stringify(run.managed?.budget)}`,
    "Task graph:",
    ...tasks.map((task) => `- ${task.id}: ${task.title} [${task.status}] agent=${task.assignedAgent ?? "unassigned"} strategy=${task.strategy} attempts=${task.attemptCount}`)
  ].join("\n")
  return {
    id: crypto.randomUUID(), kind: "manager", text,
    sections: [{ name: "Manager state", budget: 2000, estimatedTokens: estimateTokens(text) }],
    memoryIds: [], conversationEntryIds: [], artifactIds: [], conflicts: [],
    estimatedTokens: estimateTokens(text), createdAt: new Date().toISOString()
  }
}

function budgetExhausted(run: WorkflowRun) {
  const budget = run.managed!.budget
  return budget.callsUsed >= budget.callLimit ||
    Date.now() - Date.parse(budget.startedAt) >= budget.timeLimitMs ||
    budget.costUsedUsd >= budget.costLimitUsd
}

function countTasks(tasks: ManagerTask[]) {
  const counts = { pending: 0, running: 0, completed: 0, failed: 0, stopped: 0 }
  for (const task of tasks) counts[task.status] += 1
  return counts
}
