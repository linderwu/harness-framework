import type {
  AgentKind,
  Artifact,
  WorkflowEventSkill,
  WorkflowRun,
  WorkflowStage
} from "@/lib/types"
import type { AgentArtifactResult } from "@/lib/workflow"

export interface AgentInvocationInput {
  run: WorkflowRun
  skill: WorkflowEventSkill
  executor: AgentKind
  stage: WorkflowStage
  artifactType: Artifact["type"]
  title: string
  fallbackBody: string
}

interface BridgeResponse {
  id?: string
  status?: "completed" | "failed"
  output?: string
  error?: string
  stderr?: string
}

export async function invokeConfiguredAgent(
  input: AgentInvocationInput
): Promise<AgentArtifactResult | undefined> {
  if (input.executor !== "codex") {
    return undefined
  }

  const bridgeUrl = process.env.CODEX_BRIDGE_URL

  if (!bridgeUrl) {
    return undefined
  }

  try {
    const response = await fetch(new URL("agent-runs", normalizeUrl(bridgeUrl)), {
      method: "POST",
      headers: createBridgeHeaders(),
      body: JSON.stringify({
        workflowRunId: input.run.id,
        projectName: input.run.projectName,
        repository: input.run.repository,
        requirement: input.run.requirement,
        stage: input.stage,
        artifactType: input.artifactType,
        title: input.title,
        skill: input.skill,
        artifacts: input.run.artifacts,
        fallbackBody: input.fallbackBody
      })
    })

    const data = (await response.json().catch(() => ({}))) as BridgeResponse

    if (!response.ok) {
      return {
        status: "failed",
        source: "codex-bridge",
        body: [
          `Codex bridge request failed with HTTP ${response.status}.`,
          data.error ? `Error: ${data.error}` : undefined
        ]
          .filter(Boolean)
          .join("\n")
      }
    }

    return {
      status: data.status === "failed" ? "failed" : "completed",
      source: "codex-bridge",
      externalRunId: data.id,
      body:
        data.output?.trim() ||
        data.error ||
        data.stderr ||
        "Codex bridge completed without a final message."
    }
  } catch (error) {
    return {
      status: "failed",
      source: "codex-bridge",
      body: `Codex bridge is not reachable: ${formatError(error)}`
    }
  }
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}

function createBridgeHeaders() {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  }
  const token = process.env.CODEX_BRIDGE_TOKEN

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  return headers
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
