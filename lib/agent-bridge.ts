import type {
  AgentKind,
  Artifact,
  WorkflowEventSkill,
  WorkflowRun,
  WorkflowStage
} from "@/lib/types"
import {
  createOpenClawA2AEnvelope,
  extractA2AResponseText,
  resolveOpenClawA2AProtocol
} from "@/lib/a2a-protocol"
import { getAgentProfile } from "@/lib/agents"
import { ensureGitHubRepository } from "@/lib/github-repository"
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
  statusMessage?: string
  idempotencyKey?: string
  artifacts?: Array<{ type: string; title: string; body: string }>
  capabilities?: string[]
}

export async function invokeConfiguredAgent(
  input: AgentInvocationInput
): Promise<AgentArtifactResult | undefined> {
  const profile = getAgentProfile(input.executor)

  if (input.skill.id === "intake.requirement") {
    return invokeIntakeAgent(input)
  }

  if (profile.family === "manual") {
    return undefined
  }

  const idempotencyKey = createIdempotencyKey(input)
  const a2aCommand = getOpenClawA2ACommand(input.executor)

  if (a2aCommand) {
    return invokeOpenClawA2A(input, a2aCommand, idempotencyKey)
  }

  const bridgeUrl = getAgentBridgeUrl(input.executor)
  const source = getBridgeSource(input.executor)

  if (!bridgeUrl) {
    return createMissingBridgeResult(input, source)
  }

  try {
    const response = await fetch(new URL("agent-runs", normalizeUrl(bridgeUrl)), {
      method: "POST",
      headers: createBridgeHeaders(input.executor, idempotencyKey),
      body: JSON.stringify({
        protocolVersion: "harness-agent-bridge/v0.2",
        idempotencyKey,
        workflowRunId: input.run.id,
        workflowVersion: input.run.version,
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
      idempotencyKey: data.idempotencyKey ?? idempotencyKey,
      statusMessage: data.statusMessage,
      artifacts: data.artifacts,
      capabilities: data.capabilities,
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

async function invokeIntakeAgent(
  input: AgentInvocationInput
): Promise<AgentArtifactResult> {
  const repositoryRequest = input.run.repository.trim()
  const source = getIntakeSource(input.executor)

  try {
    const repository = repositoryRequest
      ? await ensureGitHubRepository(repositoryRequest)
      : ""

    return {
      status: "completed",
      source,
      repository,
      statusMessage: repository
        ? `Repository ready: ${repository}.`
        : "No repository requested during intake.",
      body: [
        `Project: ${input.run.projectName}`,
        repository ? `Repository ready: ${repository}` : "Repository: not requested",
        "Requirement:",
        input.run.requirement
      ].join("\n")
    }
  } catch (error) {
    return {
      status: "failed",
      source,
      body: `Intake agent could not create or verify the GitHub repository: ${formatError(error)}`
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

async function invokeOpenClawA2A(
  input: AgentInvocationInput,
  command: string,
  idempotencyKey: string
): Promise<AgentArtifactResult> {
  const profile = getAgentProfile(input.executor)
  const sessionKey = getOpenClawA2ASessionKey(input.executor)
  const model = process.env.OPENCLAW_A2A_MODEL ?? "minimax/MiniMax-M2.7"
  const protocol = resolveOpenClawA2AProtocol()
  const envelope = createOpenClawA2AEnvelope(
    {
      ...input,
      idempotencyKey,
      sessionKey,
      mainAgent: profile.mainAgent
    },
    protocol
  )

  try {
    const result = await runCommandWithStdin(command, JSON.stringify(envelope), {
      OPENCLAW_A2A_AGENT: profile.mainAgent ?? "rowlet",
      OPENCLAW_A2A_MODEL: model,
      OPENCLAW_A2A_PROTOCOL: protocol,
      OPENCLAW_A2A_SESSION_KEY: sessionKey
    })
    return {
      status: result.exitCode === 0 ? "completed" : "failed",
      source: "openclaw-a2a",
      externalRunId: idempotencyKey,
      idempotencyKey,
      statusMessage:
        result.exitCode === 0
          ? `A2A (${protocol}) session ${sessionKey} replied.`
          : `A2A command exited with ${result.exitCode}.`,
      body:
        extractA2AResponseText(result.stdout).trim() ||
        result.stderr.trim() ||
        "OpenClaw A2A completed without a final message."
    }
  } catch (error) {
    return {
      status: "failed",
      source: "openclaw-a2a",
      externalRunId: idempotencyKey,
      idempotencyKey,
      body: `${profile.label} A2A command failed: ${formatError(error)}`
    }
  }
}

async function runCommandWithStdin(
  command: string,
  stdin: string,
  env: Record<string, string>
) {
  const { spawn } = await import("child_process")
  const timeoutMs = Number(process.env.OPENCLAW_A2A_TIMEOUT_MS ?? 600000)
  const child = spawn(command, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ...env
    }
  })
  let stdout = ""
  let stderr = ""
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  child.stdin.end(stdin)

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
  clearTimeout(timer)

  return { exitCode, stdout, stderr }
}

function createMissingBridgeResult(
  input: AgentInvocationInput,
  source: AgentArtifactResult["source"]
): AgentArtifactResult {
  if (process.env.HARNESS_ALLOW_SIMULATED_AGENTS === "1") {
    return {
      status: "completed",
      source: "simulated",
      body: input.fallbackBody,
      statusMessage: "Simulated because HARNESS_ALLOW_SIMULATED_AGENTS=1."
    }
  }

  return {
    status: "failed",
    source,
    body: `${getAgentProfile(input.executor).label} has no configured bridge. Set CODEX_BRIDGE_URL, OPENCLAW_BRIDGE_URL, or OPENCLAW_A2A_COMMAND.`
  }
}

function createIdempotencyKey(input: AgentInvocationInput) {
  return [
    input.run.id,
    input.run.version,
    input.skill.id,
    input.stage,
    input.title
  ]
    .join(":")
    .replaceAll(/\s+/g, "-")
}

function createBridgeHeaders(agent: AgentKind = "codex", idempotencyKey?: string) {
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

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey
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

function getOpenClawA2ACommand(agent: AgentKind) {
  const profile = getAgentProfile(agent)

  if (profile.family !== "openclaw") {
    return undefined
  }

  return process.env.OPENCLAW_A2A_COMMAND
}

function getOpenClawA2ASessionKey(agent: AgentKind) {
  const profile = getAgentProfile(agent)
  return (
    process.env.OPENCLAW_A2A_SESSION_KEY ??
    `agent:${profile.mainAgent ?? "rowlet"}:a2a-codex`
  )
}

function getBridgeSource(agent: AgentKind): AgentArtifactResult["source"] {
  return getAgentProfile(agent).family === "openclaw"
    ? "openclaw-bridge"
    : "codex-bridge"
}

function getIntakeSource(agent: AgentKind): AgentArtifactResult["source"] {
  return getAgentProfile(agent).family === "manual" ? "simulated" : getBridgeSource(agent)
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
