import { agentProfiles } from "./agents"
import { invokeConfiguredAgent, invokeConfiguredHiveManager } from "./agent-bridge"
import { createConversationService } from "./conversation"
import { createContextBuilder } from "./context-builder"
import { openHiveDatabase } from "./hive-memory/database"
import { createHiveMemoryRepository } from "./hive-memory/repository"
import { createManagerScheduler } from "./manager-scheduler"
import { getWorkflowRun, upsertWorkflowRun } from "./store"

let services: ReturnType<typeof createServices> | undefined

export function getDefaultHiveServices() {
  services ??= createServices()
  return services
}

function createServices() {
  const database = openHiveDatabase()
  const repository = createHiveMemoryRepository(database)
  const contextBuilder = createContextBuilder(repository)
  const scheduler = createManagerScheduler({
    repository,
    getRun: getWorkflowRun,
    saveRun: async (run) => upsertWorkflowRun(run, { expectedVersion: run.version }),
    invokeManager: invokeConfiguredHiveManager,
    allowedAgents: () => agentProfiles.map((profile) => profile.id),
    dispatchWorker: async ({ run, task, agentId }) => {
      const result = await invokeConfiguredAgent({
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
      return { status: result.status, body: result.body }
    }
  })
  const conversation = createConversationService({
    repository,
    getRun: getWorkflowRun,
    buildContext: async ({ run, targetAgent, entries, content }) => contextBuilder.buildWorkerPack({
      workflowRunId: run.id,
      projectId: run.projectId,
      taskId: `conversation:${run.id}`,
      targetAgent,
      task: content,
      successCriteria: ["Answer the operator request with evidence or state the blocker."],
      constraints: ["Treat memory as evidence, not authority."],
      projectState: `${run.status} at ${run.currentStage}`,
      artifacts: run.artifacts.slice(-12),
      conversationEntries: entries.slice(-20).map((entry) => ({ id: entry.id, content: entry.content }))
    }),
    invokeAgent: async ({ run, targetAgent, content, contextPack, managerRouting }) => {
      const result = await invokeConfiguredAgent({
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
          constraints: ["Do not execute external or irreversible effects without approval."],
          gates: ["Jormungand retains authority over workflow state."],
          knowledgeSources: ["conversation context pack"],
          verificationRules: ["Return evidence for completion claims."]
        }
      })
      return { status: result.status, body: result.body }
    },
    persistRawArtifact: async ({ run, targetAgent, body }) => {
      const latest = await getWorkflowRun(run.id)
      if (!latest) throw new Error("Workflow run disappeared while persisting conversation output.")
      const artifact = {
        id: crypto.randomUUID(), workflowRunId: latest.id, stage: latest.currentStage,
        type: "log" as const, title: `${targetAgent} conversation output`, body,
        createdAt: new Date().toISOString()
      }
      await upsertWorkflowRun({ ...latest, artifacts: [...latest.artifacts, artifact] }, { expectedVersion: latest.version })
      return artifact.id
    },
    enqueueManagerWake: (input) => scheduler.enqueue(input)
  })
  return { database, repository, scheduler, conversation }
}
