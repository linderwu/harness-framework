import type {
  AgentKind,
  Artifact,
  WorkflowEventSkill,
  WorkflowRun,
  WorkflowStage
} from "@/lib/types"
import { getAgentProfile } from "@/lib/agents"
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
  const profile = getAgentProfile(input.executor)

  if (profile.family === "manual") {
    return undefined
  }

  const bridgeUrl = getAgentBridgeUrl(input.executor)
  const source = getBridgeSource(input.executor)

  if (!bridgeUrl) {
    return undefined
  }

  try {
    const response = await fetch(new URL("agent-runs", normalizeUrl(bridgeUrl)), {
      method: "POST",
      headers: createBridgeHeaders(input.executor),
      body: JSON.stringify({
        workflowRunId: input.run.id,
        projectName: input.run.projectName,
        repository: input.run.repository,
        requirement: input.run.requirement,
        contextFiles: input.run.contextFiles ?? [],
        stage: input.stage,
        artifactType: input.artifactType,
        title: input.title,
        executor: input.executor,
        agentFamily: profile.family,
        mainAgent: profile.mainAgent,
        skill: input.skill,
        artifacts: input.run.artifacts,
        fallbackBody: input.fallbackBody
      })
    })

    const data = (await response.json().catch(() => ({}))) as BridgeResponse

    if (!response.ok) {
      return {
        status: "failed",
        source,
        body: [
          `${profile.label} bridge request failed with HTTP ${response.status}.`,
          data.error ? `Error: ${data.error}` : undefined
        ]
          .filter(Boolean)
          .join("\n")
      }
    }

    return {
      status: data.status === "failed" ? "failed" : "completed",
      source,
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
      source,
      body: `${profile.label} bridge is not reachable: ${formatError(error)}`
    }
  }
}

export async function cancelConfiguredAgentRun(run: WorkflowRun) {
  await sendConfiguredAgentControl(run, "cancel")
}

export async function stopConfiguredAgentRun(run: WorkflowRun) {
  await sendConfiguredAgentControl(run, "stop")
}

async function sendConfiguredAgentControl(
  run: WorkflowRun,
  action: "cancel" | "stop"
) {
  const bridgeUrl = getAgentBridgeUrl(run.selectedAgent)

  if (!bridgeUrl) {
    return
  }

  await fetch(new URL(`workflow-runs/${run.id}/${action}`, normalizeUrl(bridgeUrl)), {
    method: "POST",
    headers: createBridgeHeaders(run.selectedAgent),
    signal: AbortSignal.timeout(2000)
  }).catch(() => undefined)
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}

function createBridgeHeaders(agent: AgentKind = "codex") {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  }
  const profile = getAgentProfile(agent)
  const token =
    profile.family === "openclaw"
      ? process.env.OPENCLAW_BRIDGE_TOKEN
      : process.env.CODEX_BRIDGE_TOKEN

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  return headers
}

function getAgentBridgeUrl(agent: AgentKind) {
  const profile = getAgentProfile(agent)

  if (profile.family === "codex") {
    return process.env.CODEX_BRIDGE_URL
  }

  if (profile.family === "openclaw") {
    return process.env.OPENCLAW_BRIDGE_URL
  }

  return undefined
}

function getBridgeSource(agent: AgentKind): AgentArtifactResult["source"] {
  return getAgentProfile(agent).family === "openclaw"
    ? "openclaw-bridge"
    : "codex-bridge"
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
