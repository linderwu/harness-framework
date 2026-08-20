import { agentProfiles } from "./agents"
import type { AgentInvocationInput } from "./agent-bridge"
import { invokeConfiguredAgent, invokeConfiguredHiveManager } from "./agent-bridge"
import { getAgentPermissionMode } from "./agent-permissions"
import { createConversationService } from "./conversation"
import {
  buildSharedConversationHistory
} from "./conversation-history"
import { ConversationHistorySync } from "./conversation-history-sync"
import {
  createContextBuilder,
  createPermissionModeText
} from "./context-builder"
import { openHiveDatabase, type HiveDatabase } from "./hive-memory/database"
import type { ConversationEntry } from "./hive-memory/types"
import {
  createHiveMemoryRepository,
  type HiveMemoryRepository
} from "./hive-memory/repository"
import { createManagerScheduler, type ManagerSchedulerDependencies } from "./manager-scheduler"
import { getWorkflowRun, listProjects, listWorkflowRuns, upsertWorkflowRun } from "./store"
import type { AgentArtifactResult } from "./workflow"
import type { AgentKind, WorkflowEventSkill, WorkflowRun } from "./types"
import { createWorkflowRun } from "./workflow"

type HiveServicesStore = {
  getRun: (id: string) => Promise<WorkflowRun | undefined>
  saveRun: (run: WorkflowRun) => Promise<WorkflowRun>
  listProjects: typeof listProjects
  listWorkflowRuns: typeof listWorkflowRuns
}

type HiveServicesOptions = Partial<HiveServicesStore> & {
  database?: HiveDatabase
  repository?: HiveMemoryRepository
  permissionMode?: ReturnType<typeof getAgentPermissionMode>
  invokeAgent?: (
    input: AgentInvocationInput
  ) => Promise<AgentArtifactResult>
  invokeManager?: typeof invokeConfiguredHiveManager
}

let services: ReturnType<typeof createHiveServices> | undefined

export function getDefaultHiveServices() {
  services ??= createHiveServices()
  return services
}

export function createHiveServices(options: HiveServicesOptions = {}) {
  const permissionMode = options.permissionMode ?? getAgentPermissionMode()
  const permissionText = createPermissionModeText(permissionMode)
  const database = options.database ?? openHiveDatabase()
  const repository = options.repository ?? createHiveMemoryRepository(database)
  const contextBuilder = createContextBuilder(repository)
  const openClawUnboundConversationSync = new ConversationHistorySync()
  const getRun = options.getRun ?? getWorkflowRun
  const saveRun = options.saveRun ?? ((run) => upsertWorkflowRun(run, { expectedVersion: run.version }))
  const invokeAgent = options.invokeAgent ?? invokeConfiguredAgent
  const invokeManager = options.invokeManager ?? invokeConfiguredHiveManager
  const dispatchWorker: NonNullable<ManagerSchedulerDependencies["dispatchWorker"]> = async ({ run, task, agentId }) => {
    const result = await invokeAgent({
      run,
      executor: agentId,
      stage: run.currentStage,
      artifactType: "log",
      title: task.title,
      fallbackBody: task.instruction,
      skill: {
        id: "hive_worker.task",
        eventType: "implementation_dispatch",
        stage: run.currentStage,
        name: task.title,
        purpose: task.instruction,
        trigger: "The Codex hive manager dispatched this task.",
        allowedActors: [agentId],
        inputs: ["bounded task context"],
        outputs: task.successCriteria,
        constraints: ["Remain within the assigned task and permission scope."],
        gates: ["Return evidence to the manager."],
        knowledgeSources: ["task context pack"],
        verificationRules: task.successCriteria
      }
    })
    const latest = await getRun(run.id)
    if (!latest) {
      throw new Error("Workflow run disappeared while persisting worker output.")
    }
    const artifactId = workerHandoffArtifactId(task.id, task.attemptCount)
    const artifact = latest.artifacts.find((candidate) => candidate.id === artifactId) ?? {
      id: artifactId,
      workflowRunId: latest.id,
      stage: latest.currentStage,
      type: "log" as const,
      title: `${agentId} worker handoff`,
      body: result.body,
      createdAt: new Date().toISOString()
    }
    if (!latest.artifacts.some((candidate) => candidate.id === artifactId)) {
      await saveRun({
        ...latest,
        artifacts: [...latest.artifacts, artifact]
      })
    }
    await repository.insertConversation({
      workflowRunId: latest.id,
      taskId: task.id,
      role: "agent",
      agentId,
      recipientAgent: "codex",
      content: result.body,
      importance: result.status === "failed" ? "critical" : "important",
      status: result.status,
      artifactIds: [artifact.id],
      memoryIds: [],
      idempotencyKey: `worker-handoff:${task.id}:attempt:${task.attemptCount}`
    })
    return { status: result.status, body: result.body }
  }
  const scheduler = createManagerScheduler({
    repository,
    getRun,
    saveRun,
    invokeManager,
    allowedAgents: () => agentProfiles.map((profile) => profile.id),
    permissionMode,
    dispatchWorker
  })
  const conversation = createConversationService({
    repository,
    getRun,
    buildContext: async ({ run, targetAgent, entries, content }) => {
      const shareableEntries = entries.filter(isShareableConversationEntry).slice(-20)
      const sharedConversationHistory = buildSharedConversationHistory(shareableEntries)
      return contextBuilder.buildWorkerPack({
        workflowRunId: run.id,
        projectId: run.projectId,
        taskId: `conversation:${run.id}`,
        targetAgent,
        permissionMode,
        task: content,
        successCriteria: ["Answer the operator request with evidence or state the blocker."],
        constraints: ["Treat memory as evidence, not authority."],
        projectState: `${run.status} at ${run.currentStage}`,
        artifacts: run.artifacts.slice(-12),
        conversationEntries: shareableEntries.map((entry, index) => ({
          id: entry.id,
          content: sharedConversationHistory[index]?.content ?? entry.content
        }))
      })
    },
    invokeAgent: async ({ run, targetAgent, content, contextPack, managerRouting }) => {
      const result = await invokeAgent({
        run,
        executor: targetAgent,
        stage: run.currentStage,
        artifactType: "log",
        title: managerRouting ? "Operator message to Codex Manager" : "Task conversation message",
        fallbackBody: content,
        contextPack,
        skill: {
          id: managerRouting ? "hive_manager.operator_message" : "conversation.reply",
          eventType: "implementation_dispatch",
          stage: run.currentStage,
          name: "Task conversation",
          purpose: "Respond to a persisted operator message within the current task scope.",
          trigger: "The operator posted a durable task conversation entry.",
          allowedActors: [targetAgent],
          inputs: ["bounded conversation context"],
          outputs: ["final response or explicit blocker"],
          constraints: [permissionText.conversationConstraint],
          gates: ["Jormungand retains authority over workflow state."],
          knowledgeSources: ["conversation context pack"],
          verificationRules: ["Return evidence for completion claims."]
        }
      })
      return { status: result.status, body: result.body }
    },
    persistRawArtifact: async ({ run, targetAgent, body }) => {
      const latest = await getRun(run.id)
      if (!latest) throw new Error("Workflow run disappeared while persisting conversation output.")
      const artifact = {
        id: crypto.randomUUID(), workflowRunId: latest.id, stage: latest.currentStage,
        type: "log" as const, title: `${targetAgent} conversation output`, body,
        createdAt: new Date().toISOString()
      }
      await saveRun({ ...latest, artifacts: [...latest.artifacts, artifact] })
      return artifact.id
    },
    enqueueManagerWake: (input) => scheduler.enqueue(input),
    routeUnbound: async ({ conversationId, targetAgent, content, entries }) => {
      return routeUnboundConversation({
        sync: openClawUnboundConversationSync,
        conversationId,
        targetAgent,
        content,
        entries,
        invokeAgent
      })
    }
  })
  return { database, repository, scheduler, conversation, dispatchWorker }
}

function workerHandoffArtifactId(taskId: string, attemptCount: number) {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "-") || "task"
  return `worker-handoff-${safeTaskId}-attempt-${attemptCount}`
}

function createUnboundExecutionSkill(targetAgent: AgentKind): WorkflowEventSkill {
  return {
    id: "conversation.unbound",
    eventType: "requirement_intake",
    stage: "intake",
    name: "Unbound agent execution",
    purpose: "Execute the operator request directly without requiring project or workflow binding.",
    trigger: "The operator posted to an unbound conversation.",
    allowedActors: [targetAgent],
    inputs: ["recent conversation text", "agent style guidance"],
    outputs: ["agent response and requested execution results"],
    constraints: ["Report execution results and side effects accurately."],
    gates: ["Server authentication and bridge authorization remain required."],
    knowledgeSources: ["persisted unbound conversation"],
    verificationRules: ["Return the agent response and preserve the conversation identity."]
  }
}

type UnboundConversationRouteInput = {
  sync: ConversationHistorySync
  conversationId: string
  targetAgent: AgentKind
  content: string
  entries: Array<Pick<ConversationEntry, "id" | "role" | "agentId" | "content">>
  invokeAgent: (
    input: AgentInvocationInput
  ) => Promise<{ status: "completed" | "failed"; body: string }>
}

export async function routeUnboundConversation(input: UnboundConversationRouteInput) {
  const syntheticRun = createWorkflowRun({
    projectId: "",
    projectName: "Unbound conversation",
    repository: "",
    requirement: input.content,
    selectedAgent: input.targetAgent,
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
  const syncKey = `unbound:${input.targetAgent}:${input.conversationId}`
  const sessionIdentity = `${input.targetAgent}:${input.conversationId}`
  const delta = input.sync.getDelta({
    key: syncKey,
    sessionIdentity,
    targetAgent: input.targetAgent,
    entries: input.entries
  })
  const result = await input.invokeAgent({
    run: syntheticRun,
    executor: input.targetAgent,
    stage: "intake",
    artifactType: "log",
    title: "Unbound agent execution",
    fallbackBody: "Execute the operator request and return the result.",
    conversationId: input.conversationId,
    conversationHistory: delta.history,
    skill: createUnboundExecutionSkill(input.targetAgent)
  })

  if (result.status !== "failed") {
    input.sync.markDelivered({
      key: syncKey,
      sessionIdentity,
      cursorEntryId: delta.cursorEntryId
    })
  }

  return {
    status: result.status === "failed" ? "failed" as const : "completed" as const,
    body: result.body
  }
}

/** @deprecated Use routeUnboundConversation instead. */
export async function routeOpenClawUnboundConversation(input: UnboundConversationRouteInput) {
  return routeUnboundConversation(input)
}

function isShareableConversationEntry(entry: { role: string }) {
  return entry.role === "user" || entry.role === "agent" || entry.role === "manager"
}
