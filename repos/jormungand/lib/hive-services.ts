import { agentProfiles, getAgentProfile, getOpenClawMainAgent } from "./agents"
import type { AgentInvocationInput } from "./agent-bridge"
import { invokeConfiguredAgent, invokeConfiguredHiveManager } from "./agent-bridge"
import { getAgentPermissionMode } from "./agent-permissions"
import { createConversationService } from "./conversation"
import { ConversationLifecycleService } from "./conversation-lifecycle/service"
import {
  ConversationDispatcher,
  ConversationQueueService
} from "./conversation-dispatcher"
import {
  buildSharedConversationHistory,
  sharedConversationHistoryLimit
} from "./conversation-history"
import { ConversationHistorySync } from "./conversation-history-sync"
import { getCodexConversationState } from "./codex-conversation"
import { createCodexSyncWorker } from "./codex-sync-worker"
import { createContextBuilder, createPermissionModeText } from "./context-builder"
import { openHiveDatabase, type HiveDatabase } from "./hive-memory/database"
import type { ConversationEntry } from "./hive-memory/types"
import { createHiveMemoryRepository, type HiveMemoryRepository } from "./hive-memory/repository"
import { createManagerScheduler, type ManagerSchedulerDependencies } from "./manager-scheduler"
import { deriveOpenClawSessionIdentity } from "./openclaw-session"
import { getWorkflowRun, listProjects, listWorkflowRuns, upsertWorkflowRun } from "./store"
import type { AgentKind, CodexReasoningIntensity, WorkflowEventSkill, WorkflowRun } from "./types"
import type { AgentArtifactResult } from "./workflow"
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
  invokeAgent?: (input: AgentInvocationInput) => Promise<AgentArtifactResult>
  invokeManager?: typeof invokeConfiguredHiveManager
  startCodexSyncWorker?: boolean
}

let services: ReturnType<typeof createHiveServices> | undefined

export function getDefaultHiveServices() {
  services ??= createHiveServices({ startCodexSyncWorker: true })
  return services
}

export function createHiveServices(options: HiveServicesOptions = {}) {
  const permissionMode = options.permissionMode ?? getAgentPermissionMode()
  const permissionText = createPermissionModeText(permissionMode)
  const database = options.database ?? openHiveDatabase()
  const repository = options.repository ?? createHiveMemoryRepository(database)
  const contextBuilder = createContextBuilder(repository)
  const conversationLifecycle = new ConversationLifecycleService(repository)
  const conversationQueue = new ConversationQueueService(repository)
  const getRun = options.getRun ?? getWorkflowRun
  const saveRun = options.saveRun ?? ((run) => upsertWorkflowRun(run, { expectedVersion: run.version }))
  const invokeAgent = options.invokeAgent ?? invokeConfiguredAgent
  const invokeManager = options.invokeManager ?? invokeConfiguredHiveManager
  const dispatchWorker: NonNullable<ManagerSchedulerDependencies["dispatchWorker"]> = async function dispatchWorker({ run, task, agentId }) {
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
    if (!latest) throw new Error("Workflow run disappeared while persisting worker output.")
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
      await saveRun({ ...latest, artifacts: [...latest.artifacts, artifact] })
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
    lifecycle: conversationLifecycle,
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
    invokeAgent: async ({
      run,
      targetAgent,
      content,
      contextPack,
      managerRouting,
      conversationId
    }) => {
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
        },
        conversationId
      })
      return {
        status: result.status,
        body: result.body,
        ...(result.deliveryState ? { deliveryState: result.deliveryState } : {})
      }
    },
    enqueueConversation: (input) => conversationQueue.enqueue(input),
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
    routeUnbound: async ({ conversationId, targetAgent, content, entries, idempotencyKey, selectedModelId, selectedReasoningIntensity }) => {
      return routeUnboundConversation({
        repository,
        conversationId,
        targetAgent,
        content,
        entries,
        idempotencyKey,
        selectedModelId,
        selectedReasoningIntensity,
        invokeAgent
      })
    }
  })
  const conversationDispatcher = new ConversationDispatcher(repository, async (input) => {
    return conversation.dispatchQueuedEntry(input)
  })
  const codexSyncWorker = createCodexSyncWorker({
    repository,
    syncConversation: (conversationId) => getCodexConversationState(
      repository,
      conversationId,
      conversationLifecycle
    )
  })
  if (options.startCodexSyncWorker) codexSyncWorker.start()
  return {
    database,
    repository,
    conversationLifecycle,
    scheduler,
    conversation,
    conversationQueue,
    conversationDispatcher,
    dispatchWorker,
    codexSyncWorker
  }
}

function workerHandoffArtifactId(taskId: string, attemptCount: number) {
  const safeTaskId = taskId.replace(/[^A-Za-z0-9._-]/g, "-") || "task"
  return `worker-handoff-${safeTaskId}-attempt-${attemptCount}`
}

export async function routeOpenClawUnboundConversation(input: {
  sync: ConversationHistorySync
  conversationId: string
  targetAgent: AgentKind
  content: string
  entries: Array<Pick<ConversationEntry, "id" | "role" | "agentId" | "content">>
  invokeAgent: (
    input: AgentInvocationInput
  ) => Promise<{ status: "completed" | "failed"; body: string }>
}) {
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
    title: "Direct conversation execution",
    fallbackBody: input.content,
    conversationId: input.conversationId,
    conversationHistory: delta.history,
    skill: createDirectExecutionSkill(input.targetAgent)
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

export async function routeUnboundConversation(input: {
  repository: HiveMemoryRepository
  conversationId: string
  targetAgent: AgentKind
  content: string
  entries: Array<Pick<ConversationEntry, "id" | "role" | "agentId" | "content">>
  idempotencyKey?: string
  selectedModelId?: string
  selectedReasoningIntensity?: CodexReasoningIntensity
  invokeAgent: (
    input: AgentInvocationInput
  ) => Promise<Pick<AgentArtifactResult, "status" | "body" | "deliveryState">>
}) {
  if (getAgentProfile(input.targetAgent).family === "openclaw") {
    return routeDirectOpenClawConversation(input)
  }

  const conversationMetadata = input.targetAgent === "codex"
    ? input.repository.getConversationMetadata(input.conversationId)
    : undefined
  const selectedModelId = input.targetAgent === "codex"
    ? (input.selectedModelId ?? conversationMetadata?.selectedModelId)?.trim() || undefined
    : undefined
  const selectedReasoningIntensity = input.targetAgent === "codex"
    ? input.selectedReasoningIntensity ?? conversationMetadata?.selectedReasoningIntensity
    : undefined
  const syntheticRun = createWorkflowRun({
    projectId: "",
    projectName: "Unbound conversation",
    repository: "",
    requirement: input.content,
    selectedAgent: input.targetAgent,
    selectedModelId,
    selectedReasoningIntensity,
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
  const result = await input.invokeAgent({
    run: syntheticRun,
    executor: input.targetAgent,
    stage: "intake",
    artifactType: "log",
    title: "Direct conversation execution",
    fallbackBody: input.content,
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
    conversationHistory: buildShareableConversationHistory(input.entries),
    skill: createDirectExecutionSkill(input.targetAgent)
  })

  return {
    status: result.status === "failed" ? "failed" as const : "completed" as const,
    body: result.body,
    ...(result.deliveryState ? { deliveryState: result.deliveryState } : {})
  }
}

function isShareableConversationEntry(entry: { role: string }) {
  return entry.role === "user" || entry.role === "agent" || entry.role === "manager"
}

const directSessionNamespace = "harness-direct-v1" as const

function createDirectExecutionSkill(targetAgent: AgentKind): WorkflowEventSkill {
  return {
    id: "conversation.direct_execution",
    eventType: "requirement_intake",
    stage: "intake",
    name: "Direct conversation execution",
    purpose:
      "Execute the authenticated operator request directly without requiring project or workflow binding.",
    trigger: "The operator posted to the persistent unbound conversation.",
    allowedActors: [targetAgent],
    inputs: ["shareable conversation history", "latest operator message"],
    outputs: ["agent response and requested execution results"],
    constraints: ["Report tool results, side effects, and blockers accurately."],
    gates: ["Server authentication and bridge authorization remain required."],
    knowledgeSources: ["persisted conversation transcript"],
    verificationRules: ["Preserve the conversation identity and return the direct response."]
  }
}

function buildShareableConversationHistory(
  entries: Array<Pick<ConversationEntry, "id" | "role" | "agentId" | "content">>
) {
  return buildSharedConversationHistory(
    entries
      .filter(isShareableConversationEntry)
      .slice(-sharedConversationHistoryLimit)
  )
}

async function routeDirectOpenClawConversation(input: {
  repository: HiveMemoryRepository
  conversationId: string
  targetAgent: AgentKind
  content: string
  entries: Array<Pick<ConversationEntry, "id" | "role" | "agentId" | "content">>
  idempotencyKey?: string
  invokeAgent: (
    input: AgentInvocationInput
  ) => Promise<Pick<AgentArtifactResult, "status" | "body" | "deliveryState">>
}) {
  const syntheticRun = createWorkflowRun({
    projectId: "",
    projectName: "Unbound conversation",
    repository: "",
    requirement: input.content,
    selectedAgent: input.targetAgent,
    designApprovalActor: "human",
    verificationApprovalActor: "human"
  })
  const mainAgent =
    getOpenClawMainAgent(input.targetAgent) ??
    getAgentProfile(input.targetAgent).mainAgent ??
    "rowlet"
  const sessionIdentity = await deriveOpenClawSessionIdentity({
    mainAgent,
    conversationId: input.conversationId
  })
  const existingState = input.repository.getOpenClawRuntimeSession(
    input.conversationId,
    input.targetAgent
  )
  const sessionMatches =
    existingState?.sessionNamespace === directSessionNamespace &&
    existingState.sessionKeyFingerprint === sessionIdentity.sessionKeyFingerprint
  const bootstrapDelivered = sessionMatches && existingState?.bootstrapDelivered === true
  const deliveryUnknown = sessionMatches && existingState?.state === "delivery_unknown"
  const persistedRuntime = await input.repository.upsertOpenClawRuntimeSession({
    conversationId: input.conversationId,
    agentId: input.targetAgent,
    sessionNamespace: directSessionNamespace,
    state: deliveryUnknown
      ? "delivery_unknown"
      : bootstrapDelivered
        ? "active"
        : "pending",
    sessionKeyFingerprint: sessionIdentity.sessionKeyFingerprint,
    bootstrapDelivered,
    lastDeliveredEntryId: sessionMatches
      ? existingState?.lastDeliveredEntryId
      : undefined
  })
  const currentUserEntryId = input.entries
    .findLast((entry) => entry.role === "user")
    ?.id
  const result = await input.invokeAgent({
    run: syntheticRun,
    executor: input.targetAgent,
    stage: "intake",
    artifactType: "log",
    title: "Direct conversation execution",
    fallbackBody: input.content,
    conversationId: input.conversationId,
    idempotencyKey: input.idempotencyKey,
    conversationHistory: bootstrapDelivered || deliveryUnknown
      ? undefined
      : buildShareableConversationHistory(input.entries),
    skill: createDirectExecutionSkill(input.targetAgent)
  })

  if (result.deliveryState === "unknown") {
    await input.repository.upsertOpenClawRuntimeSession({
      conversationId: input.conversationId,
      agentId: input.targetAgent,
      sessionNamespace: directSessionNamespace,
      state: "delivery_unknown",
      sessionKeyFingerprint: sessionIdentity.sessionKeyFingerprint,
      bootstrapDelivered: persistedRuntime?.bootstrapDelivered ?? false,
      lastDeliveredEntryId: persistedRuntime?.lastDeliveredEntryId
    })
    return {
      status: "failed" as const,
      body: result.body,
      deliveryState: result.deliveryState
    }
  }

  if (result.status === "failed") {
    await input.repository.upsertOpenClawRuntimeSession({
      conversationId: input.conversationId,
      agentId: input.targetAgent,
      sessionNamespace: directSessionNamespace,
      state: persistedRuntime?.state ?? "pending",
      sessionKeyFingerprint: sessionIdentity.sessionKeyFingerprint,
      bootstrapDelivered: persistedRuntime?.bootstrapDelivered ?? false,
      lastDeliveredEntryId: persistedRuntime?.lastDeliveredEntryId
    })
    return {
      status: "failed" as const,
      body: result.body,
      ...(result.deliveryState ? { deliveryState: result.deliveryState } : {})
    }
  }

  await input.repository.upsertOpenClawRuntimeSession({
    conversationId: input.conversationId,
    agentId: input.targetAgent,
    sessionNamespace: directSessionNamespace,
    state: "active",
    sessionKeyFingerprint: sessionIdentity.sessionKeyFingerprint,
    bootstrapDelivered: true,
    lastDeliveredEntryId: currentUserEntryId
  })

  return {
    status: "completed" as const,
    body: result.body,
    ...(result.deliveryState ? { deliveryState: result.deliveryState } : {})
  }
}
