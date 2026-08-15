import { agentProfiles } from "./agents"
import { invokeConfiguredAgent, invokeConfiguredHiveManager } from "./agent-bridge"
import { openHiveDatabase } from "./hive-memory/database"
import { createHiveMemoryRepository } from "./hive-memory/repository"
import { createManagerScheduler } from "./manager-scheduler"
import { getWorkflowRun, upsertWorkflowRun } from "./store"
import type { AgentKind } from "./types"

let services: ReturnType<typeof createServices> | undefined

export function getDefaultHiveServices() {
  services ??= createServices()
  return services
}

function createServices() {
  const database = openHiveDatabase()
  const repository = createHiveMemoryRepository(database)
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
  return { database, repository, scheduler }
}
