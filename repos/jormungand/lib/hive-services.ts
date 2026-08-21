import { agentProfiles } from "./agents"
import type { AgentInvocationInput } from "./agent-bridge"
import { invokeConfiguredAgent, invokeConfiguredHiveManager } from "./agent-bridge"
import { getAgentPermissionMode } from "./agent-permissions"
import { createConversationService, parseUnboundManagerDecision } from "./conversation"
import {
  ConversationDispatcher,
  ConversationQueueService
} from "./conversation-dispatcher"
import { buildSharedConversationHistory } from "./conversation-history"
import { ConversationHistorySync } from "./conversation-history-sync"
import { dispatchCodexConversationEntry } from "./codex-conversation"
import { createContextBuilder, createPermissionModeText } from "./context-builder"
import { openHiveDatabase, type HiveDatabase } from "./hive-memory/database"
import type { ConversationEntry } from "./hive-memory/types"
import { createHiveMemoryRepository, type HiveMemoryRepository } from "./hive-memory/repository"
import { createManagerScheduler, type ManagerSchedulerDependencies } from "./manager-scheduler"
import { getWorkflowRun, listProjects, listWorkflowRuns, upsertWorkflowRun } from "./store"
import type { AgentKind, WorkflowRun } from "./types"
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
  const conversationQueue = new ConversationQueueService(repository)
  const getRun = options.getRun ?? getWorkflowRun
  const saveRun = options.saveRun ?? ((run) => upsertWorkflowRun(run, { expectedVersion: run.version }))
  const listProjectsFn = options.listProjects ?? listProjects
  const listWorkflowRunsFn = options.listWorkflowRuns ?? listWorkflowRuns
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
    routeUnbound: async ({ conversationId, targetAgent, content, entries }) => {
      const syntheticRun = createWorkflowRun({
        projectId: "",
        projectName: "Unbound conversation",
        repository: "",
        requirement: content,
        selectedAgent: targetAgent,
        designApprovalActor: "human",
        verificationApprovalActor: "human"
      })

      if (targetAgent === "codex") {
        const [projects, runs] = await Promise.all([listProjectsFn(), listWorkflowRunsFn()])
        const candidateLines = projects.map((project) => {
          const projectRuns = runs.filter((run) => run.projectId === project.id)
          return `- ${project.name}: projectId=${project.id}; workflowRuns=${projectRuns.map((run) => `${run.id} (${run.status})`).join(", ") || "none"}`
        })
        const prompt = [
          "You are the Jormungand conversation manager.",
          "Answer the operator and decide whether this conversation clearly belongs to one existing project and workflow run.",
          "You may inspect and operate the local Jormungand harness when the operator asks, within the current sandbox and approval policy.",
          "Use the recent conversation as continuity, explain what you did, and state any permission or project-binding blocker.",
          "Keep it unbound when intent is general, ambiguous, or no matching workflow run exists.",
          "Return exactly one JSON object: {\"reply\":\"...\",\"projectId\":string|null,\"workflowRunId\":string|null}.",
          "Existing targets:",
          ...(candidateLines.length ? candidateLines : ["- none"]),
          "Recent conversation:",
          ...entries.slice(-12).map((entry) => `${entry.role}: ${entry.content}`),
          `Latest operator message: ${content}`
        ].join("\n")
        const result = await invokeAgent({
          run: syntheticRun,
          executor: "codex",
          stage: "intake",
          artifactType: "log",
          title: "Route unbound conversation",
          fallbackBody: JSON.stringify({ reply: content, projectId: null, workflowRunId: null }),
          skill: {
            id: "hive_manager.route_conversation",
            eventType: "requirement_intake",
            stage: "intake",
            name: "Route unbound conversation",
            purpose: prompt,
            trigger: "The operator posted to the persistent unbound conversation.",
            allowedActors: ["codex"],
            inputs: ["recent conversation", "existing project and workflow targets"],
            outputs: ["reply and optional validated binding"],
            constraints: [
              "Bind only when the target is unambiguous.",
              "Never invent project or workflow identifiers.",
              permissionText.workflowAuthorityConstraint
            ],
            gates: ["Jormungand validates the selected target."],
            knowledgeSources: ["persisted conversation", "workspace index"],
            verificationRules: ["Output exactly one JSON object matching the requested shape."]
          }
        })
        if (result.status === "failed") return { status: "failed" as const, body: result.body }
        return { status: "completed" as const, ...parseUnboundManagerDecision(result.body, runs) }
      }

      return routeOpenClawUnboundConversation({
        sync: openClawUnboundConversationSync,
        conversationId,
        targetAgent,
        content,
        entries,
        invokeAgent
      })
    }
  })
  const conversationDispatcher = new ConversationDispatcher(repository, async (input) => {
    const run = await getRun(input.conversationId)
    if (!run && input.targetAgent === "codex") {
      return dispatchCodexConversationEntry({
        repository,
        conversationId: input.conversationId,
        userEntryId: input.userEntry.id,
        responseEntryId: input.responseEntry?.id
      })
    }
    return conversation.dispatchQueuedEntry(input)
  })
  return { database, repository, scheduler, conversation, conversationQueue, conversationDispatcher, dispatchWorker }
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
    title: "Unbound limited conversation",
    fallbackBody: "The requested agent can only reply in unbound conversation mode.",
    conversationId: input.conversationId,
    conversationHistory: delta.history,
    skill: {
      id: "conversation.unbound_limited",
      eventType: "requirement_intake",
      stage: "intake",
      name: "Unbound limited conversation",
      purpose:
        "Respond to operator questions in safe, unbound mode without project binding, workflow mutation, or manager action.",
      trigger: "The operator posted to the persistent unbound conversation.",
      allowedActors: [input.targetAgent],
      inputs: ["recent conversation text", "agent style guidance"],
      outputs: ["final response without workflow side effects"],
      constraints: [
        "Do not perform project binding or manager routing.",
        "Do not invoke external systems or irreversible actions.",
        "Keep the answer focused on user support and guidance."
      ],
      gates: ["Unbound conversation is read-only and non-mutating."],
      knowledgeSources: ["persisted unbound conversation"],
      verificationRules: ["Return one concise text response."]
    }
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

export const routeUnboundConversation = routeOpenClawUnboundConversation

function isShareableConversationEntry(entry: { role: string }) {
  return entry.role === "user" || entry.role === "agent" || entry.role === "manager"
}
