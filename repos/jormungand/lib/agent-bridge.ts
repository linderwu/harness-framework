import type {
  AgentKind,
  Artifact,
  RuntimeSkillBundleDescriptor,
  RuntimeSkillBundleResult,
  WorkflowEventSkill,
  WorkflowRun,
  WorkflowStage
} from "./types"
import { resolve } from "node:path"
import { pathToFileURL } from "node:url"
import {
  createOpenClawA2AEnvelope,
  extractA2AResponseText,
  resolveOpenClawA2AProtocol
} from "./a2a-protocol"
import {
  getAgentLiveSnapshot,
  publishAgentLiveEvent
} from "./agent-live-bus"
import { getAgentProfile } from "./agents"
import type { AgentLiveEvent } from "./agent-live-events"
import { normalizeAgentLiveEvent } from "./agent-live-events"
import { getAgentPermissionMode } from "./agent-permissions"
import { ensureGitHubRepository } from "./github-repository"
import type { AgentArtifactResult } from "@/lib/workflow"
import type { ContextPack } from "./context-builder"

export interface AgentInvocationInput {
  run: WorkflowRun
  skill: WorkflowEventSkill
  executor: AgentKind
  stage: WorkflowStage
  artifactType: Artifact["type"]
  title: string
  fallbackBody: string
  runtimeSkillBundles?: RuntimeSkillBundleDescriptor[]
  contextPack?: ContextPack
  conversationId?: string
  conversationHistory?: Array<{
    role: "user" | "assistant"
    content: string
  }>
}

interface BridgeResponse {
  id?: string
  status?: "completed" | "failed" | "running"
  output?: string
  error?: string
  stderr?: string
  statusMessage?: string
  idempotencyKey?: string
  artifacts?: Array<{ type: string; title: string; body: string }>
  capabilities?: string[]
  runtimeSkillBundleResults?: RuntimeSkillBundleResult[]
}

interface BridgeLiveEventsResponse {
  status?: "completed" | "failed" | "running"
  nextCursor?: unknown
  events?: unknown
}

export interface AgentBridgeTestHooks {
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  livePollIntervalMs?: number
  livePollTimeoutMs?: number
  publishLiveEvent?: (event: AgentLiveEvent) => boolean
  getLastLiveSequence?: (conversationId: string) => number
}

interface AgentBridgeRuntime {
  fetch: typeof fetch
  now: () => number
  sleep: (ms: number) => Promise<void>
  livePollIntervalMs: number
  livePollTimeoutMs: number
  publishLiveEvent: (event: AgentLiveEvent) => boolean
  getLastLiveSequence: (conversationId: string) => number
}

interface OpenClawLiveRelay {
  publishStarted(): void
  startPolling(): void
  publishFinal(result: AgentArtifactResult): void
}

let agentBridgeTestHooks: AgentBridgeTestHooks = {}

const bridgeProtocolV2 = "harness-agent-bridge/v0.2"
const bridgeProtocolV3 = "harness-agent-bridge/v0.3"
const openClawA2AControlMessage =
  process.env.OPENCLAW_A2A_CONTROL_MESSAGE ?? "/stop"

export function __setAgentBridgeTestHooks(hooks: AgentBridgeTestHooks) {
  agentBridgeTestHooks = {
    ...agentBridgeTestHooks,
    ...hooks
  }
}

export function __resetAgentBridgeTestHooks() {
  agentBridgeTestHooks = {}
}

export async function invokeConfiguredAgent(
  input: AgentInvocationInput
): Promise<AgentArtifactResult> {
  const profile = getAgentProfile(input.executor)

  if (input.skill.id === "intake.requirement") {
    return invokeIntakeAgent(input)
  }

  const requiredProtocol = requiredBridgeProtocol(input)
  const configuredProtocol = getConfiguredBridgeProtocol(input.executor)

  if (requiredProtocol === bridgeProtocolV3 && configuredProtocol !== bridgeProtocolV3) {
    return {
      status: "failed",
      source: getBridgeSource(input.executor),
      body: `${profile.label} bridge does not support runtime skill bundles.`,
      statusMessage: JSON.stringify({
        runtimeSkillResolution: {
          status: "failed",
          errorCode: "runtime_skill_protocol_unsupported",
          errorMessage: `${profile.label} bridge must use ${bridgeProtocolV3} for runtime skill bundles.`
        }
      })
    }
  }

  const idempotencyKey = createIdempotencyKey(input)
  const liveRunId = createLiveSubmissionRunId(idempotencyKey)
  const a2aCommand = getOpenClawA2ACommand(input.executor)

  if (a2aCommand) {
    return invokeOpenClawA2A(input, a2aCommand, idempotencyKey)
  }

  const minimaxA2ACommand = getMinimaxA2ACommand(input.executor)

  if (minimaxA2ACommand) {
    return invokeMinimaxA2A(input, minimaxA2ACommand, idempotencyKey)
  }

  const bridgeUrl = getAgentBridgeUrl(input.executor)
  const source = getBridgeSource(input.executor)

  if (!bridgeUrl) {
    return createMissingBridgeResult(input, source)
  }

  const runtime = getAgentBridgeRuntime()
  const liveRelay = createOpenClawLiveRelay(
    input,
    bridgeUrl,
    source,
    idempotencyKey,
    liveRunId,
    runtime
  )

  try {
    liveRelay?.publishStarted()
    const responsePromise = runtime.fetch(
      new URL("agent-runs", normalizeUrl(bridgeUrl)),
      {
        method: "POST",
        headers: createBridgeHeaders(input.executor, idempotencyKey),
        body: JSON.stringify({
          protocolVersion: requiredProtocol,
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
          permissionMode: getAgentPermissionMode(),
          runtimeSkillBundles: input.runtimeSkillBundles ?? [],
          artifacts: input.run.artifacts,
          selectedModelId: input.run.selectedModelId?.trim(),
          selectedReasoningIntensity: input.run.selectedReasoningIntensity,
          fallbackBody: input.fallbackBody,
          contextPack: input.contextPack,
          conversationId: input.conversationId,
          conversationHistory: input.conversationHistory
        })
      }
    )
    liveRelay?.startPolling()
    const response = await responsePromise

    const data = (await response.json().catch(() => ({}))) as BridgeResponse

    let result: AgentArtifactResult

    if (!response.ok) {
      if (response.status === 524 || response.status === 409) {
        result = await pollBridgeRunByIdempotencyKey({
          bridgeUrl,
          executor: input.executor,
          idempotencyKey,
          profileLabel: profile.label,
          source
        })
      } else {
        result = {
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
    } else {
      result = bridgeResponseToAgentResult(data, source, idempotencyKey)
    }

    liveRelay?.publishFinal(result)
    return result
  } catch (error) {
    const result: AgentArtifactResult = {
      status: "failed",
      source,
      body: `${profile.label} bridge is not reachable: ${formatError(error)}`
    }
    liveRelay?.publishFinal(result)
    return result
  }
}

export async function invokeConfiguredHiveManager(input: {
  run: WorkflowRun
  contextPack: ContextPack
  cycle: number
}) {
  const result = await invokeConfiguredAgent({
    run: input.run,
    executor: "codex",
    stage: input.run.currentStage,
    artifactType: "log",
    title: `Hive Manager Cycle ${input.cycle}`,
    fallbackBody: "Return a manager proposal for the current mission state.",
    contextPack: input.contextPack,
    skill: {
      id: "hive_manager.cycle",
      eventType: "closeout",
      stage: input.run.currentStage,
      name: "Hive Manager Cycle",
      purpose: "Observe the mission and propose validated control-plane actions.",
      trigger: "A persisted manager wake event is ready.",
      allowedActors: ["codex"],
      inputs: ["bounded manager context pack"],
      outputs: ["structured manager proposal"],
      constraints: [
        "Do not execute external or irreversible effects.",
        "Do not raise permissions or bypass approval policy."
      ],
      gates: ["Jormungand validates every proposed action."],
      knowledgeSources: ["manager context pack"],
      verificationRules: ["Output is one JSON object matching the manager contract."]
    }
  })
  if (result.status === "failed") throw new Error(result.body)
  return result.body
}

async function pollBridgeRunByIdempotencyKey(input: {
  bridgeUrl: string
  executor: AgentKind
  idempotencyKey: string
  profileLabel: string
  source: AgentArtifactResult["source"]
}): Promise<AgentArtifactResult> {
  const timeoutMs = Number(process.env.AGENT_BRIDGE_RECOVERY_TIMEOUT_MS ?? 900000)
  const pollIntervalMs = Number(
    process.env.AGENT_BRIDGE_RECOVERY_POLL_INTERVAL_MS ?? 5000
  )
  const deadline = Date.now() + timeoutMs
  let lastStatus = "not found"

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)

    const response = await fetch(
      new URL(
        `agent-runs/by-idempotency/${encodeURIComponent(input.idempotencyKey)}`,
        normalizeUrl(input.bridgeUrl)
      ),
      {
        headers: createBridgeHeaders(input.executor, input.idempotencyKey)
      }
    ).catch(() => undefined)

    if (!response) {
      lastStatus = "unreachable"
      continue
    }

    const data = (await response.json().catch(() => ({}))) as BridgeResponse

    if (response.ok && data.status !== "running") {
      return bridgeResponseToAgentResult(data, input.source, input.idempotencyKey)
    }

    lastStatus = response.ok ? data.status ?? "running" : `HTTP ${response.status}`
  }

  return {
    status: "failed",
    source: input.source,
    idempotencyKey: input.idempotencyKey,
    body: `${input.profileLabel} bridge timed out and recovery polling did not return a completed result (${lastStatus}).`
  }
}

function bridgeResponseToAgentResult(
  data: BridgeResponse,
  source: AgentArtifactResult["source"],
  idempotencyKey: string
): AgentArtifactResult {
  const output =
    typeof data.output === "string" && data.output !== ""
      ? data.output
      : data.error ||
        data.stderr ||
        "Codex bridge completed without a final message."

  return {
    status: data.status === "failed" ? "failed" : "completed",
    source,
    externalRunId: data.id,
    idempotencyKey: data.idempotencyKey ?? idempotencyKey,
    statusMessage: data.statusMessage,
    artifacts: data.artifacts,
    capabilities: data.capabilities,
    runtimeSkillBundleResults: data.runtimeSkillBundleResults,
    body: output
  }
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function getAgentBridgeRuntime(): AgentBridgeRuntime {
  return {
    fetch: agentBridgeTestHooks.fetch ?? globalThis.fetch.bind(globalThis),
    now: agentBridgeTestHooks.now ?? Date.now,
    sleep: agentBridgeTestHooks.sleep ?? sleep,
    livePollIntervalMs: Math.max(
      0,
      agentBridgeTestHooks.livePollIntervalMs ??
        Number(process.env.AGENT_BRIDGE_LIVE_POLL_INTERVAL_MS ?? 500)
    ),
    livePollTimeoutMs: Math.max(
      1,
      agentBridgeTestHooks.livePollTimeoutMs ??
        Number(process.env.AGENT_BRIDGE_LIVE_POLL_TIMEOUT_MS ?? 900000)
    ),
    publishLiveEvent:
      agentBridgeTestHooks.publishLiveEvent ?? ((event) => publishAgentLiveEvent(event)),
    getLastLiveSequence:
      agentBridgeTestHooks.getLastLiveSequence ??
      ((conversationId) => getAgentLiveSnapshot(conversationId).lastSequence)
  }
}

function createOpenClawLiveRelay(
  input: AgentInvocationInput,
  bridgeUrl: string,
  source: AgentArtifactResult["source"],
  idempotencyKey: string,
  liveRunId: string,
  runtime: AgentBridgeRuntime
): OpenClawLiveRelay | undefined {
  const conversationId = input.conversationId?.trim()

  if (!conversationId || getAgentProfile(input.executor).family !== "openclaw") {
    return undefined
  }

  const liveConversationId = conversationId
  const baseSequence = Math.max(runtime.getLastLiveSequence(liveConversationId) + 1, 0)
  const metadata = {
    runId: liveRunId,
    source,
    phase: input.stage
  }
  let lastPublishedSequence = baseSequence - 1
  let cursor = 0
  let stopped = false
  let terminalPublished = false
  let activePollController: AbortController | undefined

  function shouldStopPolling() {
    return stopped || terminalPublished
  }

  function publishEvent(payload: {
    id?: string
    sequence: number
    type: string
    message?: string
    text?: string
    delta?: string
    createdAt?: string
  }) {
    try {
      const event = normalizeAgentLiveEvent({
        ...payload,
        conversationId: liveConversationId,
        agentId: input.executor,
        metadata
      })
      const published = runtime.publishLiveEvent(event)
      if (published) {
        lastPublishedSequence = event.sequence
      }
      if (event.type === "completed" || event.type === "failed") {
        terminalPublished = true
      }
      return published
    } catch {
      return false
    }
  }

  async function pollLiveEvents() {
    const deadline = runtime.now() + runtime.livePollTimeoutMs

    while (!shouldStopPolling() && runtime.now() < deadline) {
      await runtime.sleep(runtime.livePollIntervalMs)

      if (shouldStopPolling() || runtime.now() >= deadline) {
        return
      }

      const pollController = new AbortController()
      activePollController = pollController
      const response = await runtime
        .fetch(
          new URL(
            `agent-runs/by-idempotency/${encodeURIComponent(idempotencyKey)}/events?after=${cursor}`,
            normalizeUrl(bridgeUrl)
          ),
          {
            headers: createBridgeHeaders(input.executor, idempotencyKey),
            signal: pollController.signal
          }
        )
        .catch(() => undefined)
      if (activePollController === pollController) {
        activePollController = undefined
      }

      if (shouldStopPolling()) {
        return
      }

      if (!response || response.status === 404 || !response.ok) {
        return
      }

      const data = (await response.json().catch(() => ({}))) as BridgeLiveEventsResponse
      if (shouldStopPolling()) {
        return
      }
      const highestSequence = publishBridgeEvents(
        Array.isArray(data.events) ? data.events : []
      )
      if (shouldStopPolling()) {
        return
      }
      const nextCursor = readNonNegativeInteger(data.nextCursor)

      if (nextCursor !== undefined && nextCursor > cursor) {
        cursor = nextCursor
      } else if (highestSequence > cursor) {
        cursor = highestSequence
      }

      if (
        terminalPublished ||
        data.status === "completed" ||
        data.status === "failed"
      ) {
        return
      }
    }
  }

  function publishBridgeEvents(events: unknown[]) {
    let highestSequence = cursor

    for (const record of events) {
      const normalized = normalizeBridgeLiveRecord(record, {
        baseSequence,
        conversationId: liveConversationId,
        agentId: input.executor,
        metadata
      })

      if (!normalized) {
        continue
      }

      highestSequence = Math.max(highestSequence, normalized.originalSequence)

      if (normalized.event.type === "started") {
        continue
      }

      if (normalized.event.type === "completed" || normalized.event.type === "failed") {
        terminalPublished = true
      }

      if (runtime.publishLiveEvent(normalized.event)) {
        lastPublishedSequence = normalized.event.sequence
      }
    }

    return highestSequence
  }

  return {
    publishStarted() {
      publishEvent({
        sequence: baseSequence,
        type: "started",
        message: `Starting ${getAgentProfile(input.executor).label} bridge request.`
      })
    },
    startPolling() {
      void pollLiveEvents()
    },
    publishFinal(result) {
      stopped = true
      activePollController?.abort()
      activePollController = undefined

      if (terminalPublished) {
        return
      }

      publishEvent({
        sequence: lastPublishedSequence + 1,
        type: result.status === "failed" ? "failed" : "completed",
        message: result.statusMessage
      })
    }
  }
}

function normalizeBridgeLiveRecord(
  input: unknown,
  context: {
    baseSequence: number
    conversationId: string
    agentId: AgentKind
    metadata: AgentLiveEvent["metadata"]
  }
) {
  const value = asRecord(input)
  const originalSequence = readNonNegativeInteger(value.sequence)
  const type = readOptionalString(value.type)

  if (originalSequence === undefined || !type) {
    return undefined
  }

  try {
    const textReader =
      type === "assistant_delta" ? readOptionalRawString : readOptionalString

    return {
      originalSequence,
      event: normalizeAgentLiveEvent({
        id: readOptionalString(value.id),
        sequence: context.baseSequence + Math.max(0, originalSequence - 1),
        conversationId: context.conversationId,
        agentId: context.agentId,
        type,
        message: textReader(value.message),
        text: textReader(value.text),
        delta: typeof value.delta === "string" ? value.delta : undefined,
        createdAt: readOptionalString(value.createdAt),
        metadata: context.metadata
      })
    }
  } catch {
    return undefined
  }
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {}
  }

  return value as Record<string, unknown>
}

function readOptionalString(value: unknown) {
  if (typeof value !== "string") {
    return undefined
  }

  const text = value.trim()
  return text ? text : undefined
}

function readOptionalRawString(value: unknown) {
  if (typeof value !== "string" || value.length === 0) {
    return undefined
  }

  return value
}

function readNonNegativeInteger(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    return undefined
  }

  return value
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
  const profile = getAgentProfile(run.selectedAgent)
  const bridgeUrl = getAgentBridgeUrl(run.selectedAgent)

  if (bridgeUrl) {
    await fetch(new URL(`workflow-runs/${run.id}/${action}`, normalizeUrl(bridgeUrl)), {
      method: "POST",
      headers: createBridgeHeaders(run.selectedAgent),
      signal: AbortSignal.timeout(2000)
    }).catch(() => undefined)
    return
  }

  if (profile.family === "openclaw") {
    await sendOpenClawA2AControl(run)
  }
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}

function getConfiguredBridgeProtocol(agent: AgentKind) {
  const profile = getAgentProfile(agent)

  if (profile.family === "openclaw") {
    return process.env.OPENCLAW_BRIDGE_PROTOCOL_VERSION ?? bridgeProtocolV3
  }

  if (profile.family === "minimax") {
    return process.env.MINIMAX_BRIDGE_PROTOCOL_VERSION ?? bridgeProtocolV3
  }

  if (profile.family === "codex") {
    return process.env.CODEX_BRIDGE_PROTOCOL_VERSION ?? bridgeProtocolV3
  }

  return bridgeProtocolV2
}

function requiredBridgeProtocol(input: AgentInvocationInput) {
  return input.runtimeSkillBundles?.length ? bridgeProtocolV3 : bridgeProtocolV2
}

async function invokeOpenClawA2A(
  input: AgentInvocationInput,
  command: string,
  idempotencyKey: string
): Promise<AgentArtifactResult> {
  const profile = getAgentProfile(input.executor)
  const model = process.env.OPENCLAW_A2A_MODEL ?? "minimax/MiniMax-M2.7"
  const protocol = resolveOpenClawA2AProtocol()

  try {
    const sessionKey = await getOpenClawSessionKey({
      agent: input.executor,
      conversationId: input.conversationId,
      workflowRunId: input.run.id
    })
    const envelope = createOpenClawA2AEnvelope(
      {
        ...input,
        idempotencyKey,
        sessionKey,
        mainAgent: profile.mainAgent
      },
      protocol
    )
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

async function invokeMinimaxA2A(
  input: AgentInvocationInput,
  command: string,
  idempotencyKey: string
): Promise<AgentArtifactResult> {
  const profile = getAgentProfile(input.executor)
  const model = process.env.MINIMAX_A2A_MODEL ?? "minimax/MiniMax-M2.7"
  const sessionKey = `minimax:${profile.id}:${input.run.id}`

  try {
    const result = await runCommandWithStdin(command, JSON.stringify({
      agent: profile.id,
      model,
      sessionKey,
      idempotencyKey,
      prompt: input.fallbackBody,
      workflowRunId: input.run.id,
      stage: input.stage,
      skillId: input.skill.id
    }), {
      MINIMAX_A2A_AGENT: profile.id,
      MINIMAX_A2A_MODEL: model,
      MINIMAX_A2A_SESSION_KEY: sessionKey
    })
    return {
      status: result.exitCode === 0 ? "completed" : "failed",
      source: "minimax-a2a",
      externalRunId: idempotencyKey,
      idempotencyKey,
      statusMessage:
        result.exitCode === 0
          ? `minimax A2A session ${sessionKey} replied.`
          : `minimax A2A command exited with ${result.exitCode}.`,
      body:
        result.stdout.trim() ||
        result.stderr.trim() ||
        "minimax A2A completed without a final message."
    }
  } catch (error) {
    return {
      status: "failed",
      source: "minimax-a2a",
      externalRunId: idempotencyKey,
      idempotencyKey,
      body: `${profile.label} A2A command failed: ${formatError(error)}`
    }
  }
}

async function sendOpenClawA2AControl(run: WorkflowRun) {
  const command = getOpenClawA2ACommand(run.selectedAgent)

  if (!command) {
    return
  }

  const profile = getAgentProfile(run.selectedAgent)
  const sessionKey = await getOpenClawSessionKey({
    agent: run.selectedAgent,
    workflowRunId: run.id
  })
  const model = process.env.OPENCLAW_A2A_MODEL ?? "minimax/MiniMax-M2.7"
  const protocol = resolveOpenClawA2AProtocol()

  await runCommandWithStdin(command, openClawA2AControlMessage, {
    OPENCLAW_A2A_AGENT: profile.mainAgent ?? "rowlet",
    OPENCLAW_A2A_CONTROL_MESSAGE: openClawA2AControlMessage,
    OPENCLAW_A2A_MODEL: model,
    OPENCLAW_A2A_PROTOCOL: protocol,
    OPENCLAW_A2A_SESSION_KEY: sessionKey
  }).catch(() => undefined)
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
    body: `${getAgentProfile(input.executor).label} has no configured bridge. Set CODEX_BRIDGE_URL (for Codex and minimax), OPENCLAW_BRIDGE_URL, OPENCLAW_A2A_COMMAND, or MINIMAX_A2A_COMMAND.`
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

function createLiveSubmissionRunId(idempotencyKey: string) {
  try {
    return `${idempotencyKey}:${crypto.randomUUID()}`
  } catch {
    return `${idempotencyKey}:${Date.now()}:${Math.random().toString(36).slice(2)}`
  }
}

function createBridgeHeaders(agent: AgentKind = "codex", idempotencyKey?: string) {
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  }
  const profile = getAgentProfile(agent)
  const token =
    profile.family === "openclaw"
      ? getOpenClawBridgeToken()
      : profile.family === "minimax"
      ? getMinimaxBridgeToken()
      : process.env.CODEX_BRIDGE_TOKEN

  if (token) {
    headers.Authorization = `Bearer ${token}`
  }

  if (idempotencyKey) {
    headers["Idempotency-Key"] = idempotencyKey
  }

  return headers
}

function getOpenClawBridgeToken() {
  return (
    process.env.OPENCLAW_BRIDGE_TOKEN?.trim() ||
    process.env.OPENCLAW_GATEWAY_TOKEN?.trim() ||
    undefined
  )
}

function getMinimaxBridgeToken() {
  return (
    process.env.CODEX_BRIDGE_TOKEN?.trim() ||
    process.env.HARNESS_BRIDGE_TOKEN?.trim() ||
    process.env.MINIMAX_BRIDGE_TOKEN?.trim() ||
    process.env.MINIMAX_GATEWAY_TOKEN?.trim() ||
    undefined
  )
}

function getAgentBridgeUrl(agent: AgentKind) {
  const profile = getAgentProfile(agent)

  if (profile.family === "codex" || profile.family === "minimax") {
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

function getMinimaxA2ACommand(agent: AgentKind) {
  const profile = getAgentProfile(agent)

  if (profile.family !== "minimax") {
    return undefined
  }

  return process.env.MINIMAX_A2A_COMMAND
}

type OpenClawSessionHelper = {
  deriveOpenClawSessionKey(input: {
    mainAgent?: string
    conversationId?: unknown
    workflowRunId?: unknown
    fallbackId?: unknown
  }): string
}

let openClawSessionHelperPromise: Promise<OpenClawSessionHelper> | undefined

async function getOpenClawSessionKey(input: {
  agent: AgentKind
  conversationId?: string
  workflowRunId?: string
}) {
  const profile = getAgentProfile(input.agent)
  const mainAgent = profile.mainAgent ?? "rowlet"

  const sessionHelper = await loadOpenClawSessionHelper()
  return sessionHelper.deriveOpenClawSessionKey({
    mainAgent,
    conversationId: input.conversationId,
    workflowRunId: input.workflowRunId,
    fallbackId: process.env.OPENCLAW_A2A_SESSION_KEY ?? "a2a-codex"
  })
}

async function loadOpenClawSessionHelper() {
  if (!openClawSessionHelperPromise) {
    // Native import keeps the CommonJS test build able to execute the ESM helper.
    const loadModule = new Function(
      "modulePath",
      "return import(modulePath)"
    ) as (modulePath: string) => Promise<OpenClawSessionHelper>
    const helperPath = pathToFileURL(
      resolve(process.cwd(), "scripts/openclaw-session.mjs")
    ).href
    openClawSessionHelperPromise = loadModule(helperPath)
  }

  return openClawSessionHelperPromise
}

function getBridgeSource(agent: AgentKind): AgentArtifactResult["source"] {
  const family = getAgentProfile(agent).family
  if (family === "openclaw") return "openclaw-bridge"
  if (family === "minimax") return "minimax-bridge"
  return "codex-bridge"
}

function getIntakeSource(agent: AgentKind): AgentArtifactResult["source"] {
  return getBridgeSource(agent)
}

function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}
