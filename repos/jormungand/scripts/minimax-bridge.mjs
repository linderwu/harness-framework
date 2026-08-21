#!/usr/bin/env node
/**
 * minimax-bridge.mjs — Jormungand harness-agent-bridge/v0.3 server for the
 * minimax family of executors (currently: `mavis` aka "Lucky").
 *
 * Endpoints (all require `Authorization: Bearer <token>` when bound to a
 * non-loopback host; loopback is unauthenticated):
 *
 *   GET  /health
 *   GET  /agent-quota[?executor=mavis]   — windowed quota (lucky-style)
 *   POST /agent-runs                     — create an idempotent agent run
 *   GET  /agent-runs/:id                 — fetch a run (active or completed)
 *   GET  /agent-runs/by-idempotency/:key — same, keyed by idempotency key
 *   GET  /agent-runs/by-idempotency/:key/events?after=<cursor>
 *                                        — live event journal (polled)
 *   POST /workflow-runs/:id/cancel       — cancel every run for a workflow
 *   POST /workflow-runs/:id/stop         — same
 *
 * Backend dispatch (priority order):
 *   1. `MINIMAX_A2A_COMMAND`     — spawn a process that speaks the public
 *                                  A2A v0.3 JSON-RPC envelope on stdin/stdout
 *                                  (see lib/a2a-protocol.ts).
 *   2. `MINIMAX_BACKEND_URL`     — POST to an OpenAI-compatible
 *                                  `${url}/chat/completions` endpoint.
 *   3. `MINIMAX_BACKEND_COMMAND` — spawn a local command with the prompt on
 *                                  stdin and the run as JSON.
 *   4. (none)                    — echo the structured prompt back. Useful
 *                                  for local development without a backend.
 *
 * The bridge also tracks a windowed quota for the `mavis` executor (the
 * `lucky` quota) and exposes it at /agent-quota. This is the canonical
 * home for the Mavis quota; the codex-bridge used to host it as a
 * compatibility shim and that path is now redundant.
 *
 * Cancel is real: HTTP backends are aborted via AbortController; spawned
 * children receive SIGTERM and then SIGKILL after a grace period.
 *
 * Live events: every run keeps a small journal. Active runs are polled at
 * `?after=<cursor>`. Completed runs expose the same journal so the
 * dashboard can replay the last frames.
 */

import http from "node:http"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

// ---------- configuration ---------------------------------------------------

const host = process.env.MINIMAX_BRIDGE_HOST ?? "127.0.0.1"
const port = Number(process.env.MINIMAX_BRIDGE_PORT ?? 3002)
const token =
  process.env.MINIMAX_BRIDGE_TOKEN?.trim() ||
  process.env.HARNESS_BRIDGE_TOKEN?.trim() ||
  process.env.MINIMAX_GATEWAY_TOKEN?.trim()
const a2aCommand = process.env.MINIMAX_A2A_COMMAND?.trim()
const backendUrl = process.env.MINIMAX_BACKEND_URL?.trim()
const backendCommand = process.env.MINIMAX_BACKEND_COMMAND?.trim()
const backendToken = process.env.MINIMAX_BACKEND_TOKEN?.trim()
const defaultModel = process.env.MINIMAX_BACKEND_MODEL ?? "minimax/MiniMax-M3"
const a2aModel = process.env.MINIMAX_A2A_MODEL?.trim() || defaultModel
const a2aAgent = process.env.MINIMAX_A2A_AGENT?.trim() || "mavis"
const a2aTimeoutMs = Number(
  process.env.MINIMAX_A2A_TIMEOUT_MS ?? process.env.MINIMAX_BRIDGE_TIMEOUT_MS ?? 900000
)
const bridgeTimeoutMs = Number(process.env.MINIMAX_BRIDGE_TIMEOUT_MS ?? 900000)
const killGraceMs = Number(process.env.MINIMAX_BRIDGE_KILL_GRACE_MS ?? 5_000)
const completedRunTtlMs = Number(
  process.env.MINIMAX_BRIDGE_COMPLETED_RUN_TTL_MS ?? 30 * 60 * 1000
)

const protocolVersion = "harness-agent-bridge/v0.3"

// Quota (the `lucky` window)
const luckyQuotaWindowSeconds = Number(
  process.env.LUCKY_QUOTA_WINDOW_SECONDS ?? 5 * 3600
)

if (!isLoopbackHost(host) && !token) {
  throw new Error("MINIMAX_BRIDGE_TOKEN is required for non-loopback binding")
}

if (!a2aCommand && !backendUrl && !backendCommand) {
  // Echo is fine, just be loud so operators know.
  console.warn(
    "minimax bridge: no MINIMAX_A2A_COMMAND / MINIMAX_BACKEND_URL / " +
      "MINIMAX_BACKEND_COMMAND configured; bridge will echo structured " +
      "prompts. This is fine for local development but not for production."
  )
}

// ---------- state ----------------------------------------------------------

/**
 * @typedef {Object} JournalEvent
 * @property {string} type
 * @property {number} cursor
 * @property {string} at
 * @property {Record<string, unknown>} [data]
 */

/** @type {Map<string, JournalEvent[]>} */
const journalsByRunId = new Map()
/** @type {Map<string, { id: string, idempotencyKey?: string, workflowRunId?: string, cancel: () => void, startedAt: string, executor: string, payload: object }>} */
const activeRuns = new Map()
/** @type {Map<string, string>} idempotencyKey -> runId (active) */
const activeIdempotencyKeys = new Map()
/** @type {Map<string, object>} runId -> completed run snapshot */
const completedRuns = new Map()
/** @type {Map<string, string>} idempotencyKey -> runId (completed) */
const completedIdempotencyKeys = new Map()

const luckyState = {
  windowStartedAt: null,
  totalUsedSeconds: 0
}

// ---------- quota ----------------------------------------------------------

function getLuckyWindow(nowMs = Date.now()) {
  if (!luckyState.windowStartedAt) {
    luckyState.windowStartedAt = new Date(nowMs).toISOString()
  }
  const startMs = Date.parse(luckyState.windowStartedAt)
  const endMs = startMs + luckyQuotaWindowSeconds * 1000

  if (nowMs >= endMs) {
    luckyState.windowStartedAt = new Date(nowMs).toISOString()
    luckyState.totalUsedSeconds = 0
    return {
      startMs: nowMs,
      endMs: nowMs + luckyQuotaWindowSeconds * 1000,
      usedSeconds: 0
    }
  }

  return {
    startMs,
    endMs,
    usedSeconds: luckyState.totalUsedSeconds
  }
}

function recordLuckyUsage(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return
  getLuckyWindow() // ensures window exists
  luckyState.totalUsedSeconds += seconds
}

function readLuckyQuota() {
  const window = getLuckyWindow()
  const limit = luckyQuotaWindowSeconds
  const remaining = Math.max(0, limit - window.usedSeconds)
  const remainingPercent =
    limit > 0 ? Math.min(100, Math.max(0, (remaining / limit) * 100)) : 0

  let status = "healthy"
  if (remaining === 0) status = "exhausted"
  else if (remainingPercent < 20) status = "critical"
  else if (remainingPercent <= 50) status = "warning"

  return {
    agentId: "mavis",
    provider: "minimax",
    model: a2aModel,
    weeklyLimit: limit,
    weeklyUsed: window.usedSeconds,
    weeklyRemaining: remaining,
    remainingPercent,
    unit: "seconds",
    resetAt: new Date(window.endMs).toISOString(),
    updatedAt: new Date().toISOString(),
    status
  }
}

// ---------- journal --------------------------------------------------------

function appendJournal(runId, event) {
  const list = journalsByRunId.get(runId) ?? []
  event.cursor = list.length
  event.at = event.at ?? new Date().toISOString()
  list.push(event)
  journalsByRunId.set(runId, list)
  return event
}

function readJournal(runId, after) {
  const list = journalsByRunId.get(runId) ?? []
  const start = Number.isFinite(after) && after >= 0 ? after : 0
  return {
    events: list.slice(start),
    cursor: list.length
  }
}

function clearJournal(runId) {
  journalsByRunId.delete(runId)
}

// ---------- request helpers ------------------------------------------------

function readJson(request) {
  return new Promise((resolve, reject) => {
    let raw = ""
    request.on("data", (chunk) => {
      raw += chunk
    })
    request.on("end", () => {
      if (!raw) return resolve({})
      try {
        resolve(JSON.parse(raw))
      } catch (error) {
        reject(new Error(`invalid JSON body: ${formatError(error)}`))
      }
    })
    request.on("error", reject)
  })
}

function sendJson(response, status, body, extraHeaders = {}) {
  response.statusCode = status
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  for (const [k, v] of Object.entries(extraHeaders)) {
    response.setHeader(k, v)
  }
  response.end(JSON.stringify(body))
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

function isLoopbackHost(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1"
}

function isAuthorized(request) {
  if (!token) return true
  const header = request.headers.authorization
  return header === `Bearer ${token}`
}

function bridgeCapabilities() {
  const caps = [
    "cancel",
    "stop",
    "active-run-status",
    "idempotency-key",
    "text-output",
    "live-events",
    "runtime-skill-bundles"
  ]
  if (a2aCommand) caps.push("a2a")
  return caps
}

function backendLabel() {
  if (a2aCommand) return `a2a:${a2aCommand}`
  if (backendUrl) return `http:${backendUrl}`
  if (backendCommand) return `command:${backendCommand}`
  return "echo"
}

// ---------- protocol validation -------------------------------------------

function validateProtocol(payload) {
  if (!payload || typeof payload !== "object") {
    return "payload must be a JSON object"
  }
  if (payload.protocolVersion && payload.protocolVersion !== protocolVersion) {
    return `unsupported protocolVersion: ${payload.protocolVersion}`
  }
  if (payload.runtimeSkillBundles && !Array.isArray(payload.runtimeSkillBundles)) {
    return "runtimeSkillBundles must be an array"
  }
  return null
}

// ---------- run lifecycle --------------------------------------------------

function buildPrompt(payload) {
  const parts = []
  const executor = payload.executor ?? "minimax"
  parts.push(`You are ${executor} on the Jormungand harness.`)
  if (payload.requirement) parts.push(`Requirement: ${payload.requirement}`)
  if (payload.title) parts.push(`Task: ${payload.title}`)
  if (payload.stage) parts.push(`Stage: ${payload.stage}`)
  if (payload.artifactType) parts.push(`Artifact type: ${payload.artifactType}`)
  if (payload.skill?.purpose) parts.push(`Skill purpose: ${payload.skill.purpose}`)
  if (Array.isArray(payload.skill?.constraints) && payload.skill.constraints.length) {
    parts.push(`Constraints:\n- ${payload.skill.constraints.join("\n- ")}`)
  }
  if (payload.contextPack) {
    parts.push(`Context pack: ${JSON.stringify(payload.contextPack)}`)
  }
  if (Array.isArray(payload.artifacts) && payload.artifacts.length) {
    parts.push(
      `Artifacts so far:\n${payload.artifacts
        .map((a) => `- [${a.type}] ${a.title}\n${a.body}`)
        .join("\n")}`
    )
  }
  return parts.join("\n\n")
}

function buildA2AEnvelope({ id, payload, prompt }) {
  const executor = payload.executor ?? "mavis"
  return {
    jsonrpc: "2.0",
    id: `mavis-${id}`,
    method: "message/send",
    params: {
      message: {
        kind: "message",
        role: "user",
        messageId: `mavis-msg-${id}`,
        contextId: payload.workflowRunId ?? `mavis-ctx-${id}`,
        parts: [{ kind: "text", text: prompt }],
        metadata: {
          fromAgent: "jormungand.bridge",
          toAgent: executor,
          model: a2aModel,
          agent: a2aAgent,
          workflowRunId: payload.workflowRunId,
          stage: payload.stage,
          skillId: payload.skill?.id,
          artifactType: payload.artifactType
        }
      }
    }
  }
}

function extractA2AResponseText(data) {
  if (!data || typeof data !== "object") return ""
  const result = data.result
  if (!result) return ""

  if (typeof result.output === "string") return result.output
  if (typeof result.text === "string") return result.text
  if (typeof result.content === "string") return result.content

  const message = result.message
  if (message && Array.isArray(message.parts)) {
    const text = message.parts
      .filter((p) => p && p.kind === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("\n")
    if (text) return text
  }

  if (Array.isArray(result.artifacts)) {
    for (const artifact of result.artifacts) {
      if (Array.isArray(artifact.parts)) {
        const text = artifact.parts
          .filter((p) => p && p.kind === "text" && typeof p.text === "string")
          .map((p) => p.text)
          .join("\n")
        if (text) return text
      }
    }
  }

  if (Array.isArray(result.payloads)) {
    for (const payload of result.payloads) {
      if (typeof payload?.text === "string") return payload.text
    }
  }

  return ""
}

function extractHttpResponseText(data) {
  if (!data || typeof data !== "object") return ""
  if (typeof data.output === "string") return data.output
  if (typeof data.text === "string") return data.text
  const choice = data.choices?.[0]?.message?.content
  if (typeof choice === "string") return choice
  return ""
}

function rememberCompletedRun(runId, response) {
  completedRuns.set(runId, response)
  if (response.idempotencyKey) {
    completedIdempotencyKeys.set(response.idempotencyKey, runId)
  }
  setTimeout(() => {
    if (completedRuns.get(runId) === response) {
      completedRuns.delete(runId)
    }
    if (response.idempotencyKey) {
      const mapped = completedIdempotencyKeys.get(response.idempotencyKey)
      if (mapped === runId) {
        completedIdempotencyKeys.delete(response.idempotencyKey)
      }
    }
    clearJournal(runId)
  }, completedRunTtlMs)
}

function stopWorkflowRun(workflowRunId) {
  let stopped = 0
  for (const [id, run] of activeRuns.entries()) {
    if (run.workflowRunId === workflowRunId) {
      try {
        run.cancel()
        stopped += 1
      } catch (error) {
        console.error(`minimax: failed to cancel ${id}: ${formatError(error)}`)
      }
    }
  }
  return stopped
}

// ---------- backend dispatchers -------------------------------------------

async function runEchoBackend({ payload, prompt }) {
  return {
    status: "completed",
    output: prompt,
    statusMessage:
      "minimax bridge has no backend configured; echoed prompt back. " +
      "Set MINIMAX_A2A_COMMAND, MINIMAX_BACKEND_URL, or MINIMAX_BACKEND_COMMAND."
  }
}

async function runHttpBackend({ id, runId, payload, prompt }) {
  if (!backendUrl) {
    throw new Error("MINIMAX_BACKEND_URL is not configured")
  }
  const url = backendUrl.endsWith("/")
    ? `${backendUrl}chat/completions`
    : `${backendUrl}/chat/completions`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), bridgeTimeoutMs)

  // Register an in-flight cancel for the active run record.
  const run = activeRuns.get(runId)
  if (run) {
    run.cancel = () => {
      controller.abort()
    }
  }

  try {
    appendJournal(runId, {
      type: "status",
      data: { message: `dispatching to ${url}` }
    })
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(backendToken
          ? { Authorization: `Bearer ${backendToken}` }
          : {})
      },
      body: JSON.stringify({
        model: defaultModel,
        messages: [
          {
            role: "system",
            content: `You are ${payload.executor ?? "minimax"} on the Jormungand harness.`
          },
          { role: "user", content: prompt }
        ]
      }),
      signal: controller.signal
    }).catch((error) => {
      throw new Error(
        `minimax backend HTTP request failed: ${formatError(error)}`
      )
    })

    const data = await response.json().catch(() => ({}))

    if (!response.ok) {
      const message =
        data?.error?.message ?? data?.error ?? `HTTP ${response.status}`
      return {
        status: "failed",
        output: String(message),
        statusMessage: `minimax backend returned HTTP ${response.status}.`
      }
    }

    const output = extractHttpResponseText(data)
    appendJournal(runId, {
      type: "assistant_delta",
      data: { length: output.length }
    })
    return {
      status: "completed",
      output: output || JSON.stringify(data),
      statusMessage: "minimax backend completed via HTTP."
    }
  } catch (error) {
    if (controller.signal.aborted) {
      return {
        status: "cancelled",
        output: "",
        statusMessage: "minimax backend HTTP request was aborted."
      }
    }
    return {
      status: "failed",
      output: formatError(error),
      statusMessage: "minimax backend HTTP request failed."
    }
  } finally {
    clearTimeout(timer)
  }
}

async function runCommandBackend({ runId, payload, prompt }) {
  if (!backendCommand) {
    throw new Error("MINIMAX_BACKEND_COMMAND is not configured")
  }

  return new Promise((resolve) => {
    const child = spawn(backendCommand, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        MINIMAX_AGENT: payload.executor ?? "mavis",
        MINIMAX_MODEL: defaultModel,
        MINIMAX_PROMPT: prompt
      }
    })

    let stdout = ""
    let stderr = ""
    let killTimer = null

    const killGroup = (signal) => {
      if (child.pid == null) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== "ESRCH") {
          console.error(
            `minimax: kill -${child.pid} ${signal} failed: ${formatError(error)}`
          )
        }
      }
    }

    const finalize = (result) => {
      clearTimeout(killTimer)
      resolve(result)
    }

    const run = activeRuns.get(runId)
    if (run) {
      run.cancel = () => {
        killGroup("SIGTERM")
        killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs)
      }
    }

    appendJournal(runId, {
      type: "status",
      data: { message: `dispatching to ${backendCommand}` }
    })

    const commandTimer = setTimeout(() => {
      killGroup("SIGTERM")
      killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs)
    }, bridgeTimeoutMs)

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      stdout += text
      appendJournal(runId, {
        type: "assistant_delta",
        data: { length: text.length, stream: "stdout" }
      })
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.stdin.end(
      JSON.stringify({
        agent: payload.executor ?? "mavis",
        model: defaultModel,
        prompt,
        payload
      })
    )

    child.on("error", (error) => {
      clearTimeout(commandTimer)
      finalize({
        status: "failed",
        output: stderr || stdout || formatError(error),
        statusMessage: `minimax backend command failed: ${formatError(error)}`
      })
    })
    child.on("close", (code, signal) => {
      clearTimeout(commandTimer)
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        finalize({
          status: "cancelled",
          output: stdout,
          statusMessage: `minimax backend command cancelled via ${signal}.`
        })
        return
      }
      if (code !== 0) {
        finalize({
          status: "failed",
          output: stderr || stdout || `command exited with ${code}`,
          statusMessage: `minimax backend command exited with ${code}.`
        })
        return
      }
      finalize({
        status: "completed",
        output: stdout.trim() || "(no output)",
        statusMessage: "minimax backend command completed."
      })
    })
  })
}

async function runA2ABackend({ id, runId, payload, prompt }) {
  if (!a2aCommand) {
    throw new Error("MINIMAX_A2A_COMMAND is not configured")
  }

  const envelope = buildA2AEnvelope({ id, payload, prompt })
  const envelopeText = JSON.stringify(envelope)

  return new Promise((resolve) => {
    const child = spawn(a2aCommand, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      detached: true,
      env: {
        ...process.env,
        MINIMAX_A2A_MODEL: a2aModel,
        MINIMAX_A2A_AGENT: a2aAgent
      }
    })

    let stdout = ""
    let stderr = ""
    let killTimer = null

    const killGroup = (signal) => {
      if (child.pid == null) return
      try {
        process.kill(-child.pid, signal)
      } catch (error) {
        if (error.code !== "ESRCH") {
          console.error(
            `minimax: A2A kill -${child.pid} ${signal} failed: ${formatError(error)}`
          )
        }
      }
    }

    const finalize = (result) => {
      clearTimeout(killTimer)
      resolve(result)
    }

    const run = activeRuns.get(runId)
    if (run) {
      run.cancel = () => {
        killGroup("SIGTERM")
        killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs)
      }
    }

    appendJournal(runId, {
      type: "status",
      data: {
        message: `dispatching via A2A to ${a2aCommand}`,
        model: a2aModel,
        agent: a2aAgent
      }
    })

    const a2aTimer = setTimeout(() => {
      killGroup("SIGTERM")
      killTimer = setTimeout(() => killGroup("SIGKILL"), killGraceMs)
    }, a2aTimeoutMs)

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString()
      stdout += text
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.stdin.end(envelopeText)

    child.on("error", (error) => {
      clearTimeout(a2aTimer)
      finalize({
        status: "failed",
        output: stderr || stdout || formatError(error),
        statusMessage: `minimax A2A process failed: ${formatError(error)}`
      })
    })
    child.on("close", (code, signal) => {
      clearTimeout(a2aTimer)
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        finalize({
          status: "cancelled",
          output: stdout,
          statusMessage: `minimax A2A cancelled via ${signal}.`
        })
        return
      }
      if (code !== 0) {
        finalize({
          status: "failed",
          output: stderr || stdout || `A2A exited with ${code}`,
          statusMessage: `minimax A2A exited with ${code}.`
        })
        return
      }
      let parsed
      try {
        parsed = JSON.parse(stdout)
      } catch (error) {
        finalize({
          status: "failed",
          output: stdout || stderr || formatError(error),
          statusMessage: `minimax A2A returned non-JSON: ${formatError(error)}`
        })
        return
      }
      const output = extractA2AResponseText(parsed)
      appendJournal(runId, {
        type: "assistant_delta",
        data: { length: output.length }
      })
      finalize({
        status: "completed",
        output: output || JSON.stringify(parsed),
        statusMessage: "minimax A2A completed."
      })
    })
  })
}

// ---------- HTTP server ----------------------------------------------------

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`
    )

    if (!isAuthorized(request)) {
      sendJson(response, 401, { error: "invalid bridge token" })
      return
    }

    // ---- /health ---------------------------------------------------------
    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        protocolVersion,
        capabilities: bridgeCapabilities(),
        model: a2aModel,
        backend: backendLabel()
      })
      return
    }

    // ---- /agent-quota ----------------------------------------------------
    if (request.method === "GET" && requestUrl.pathname === "/agent-quota") {
      const executor = requestUrl.searchParams.get("executor") ?? "mavis"
      if (executor !== "mavis" && executor !== "minimax") {
        sendJson(response, 400, {
          error: `unsupported executor: ${executor}; minimax bridge only serves mavis`
        })
        return
      }
      sendJson(response, 200, readLuckyQuota())
      return
    }

    // ---- /workflow-runs/:id/cancel|stop ----------------------------------
    const controlMatch = requestUrl.pathname.match(
      /^\/workflow-runs\/([^/]+)\/(cancel|stop)$/
    )
    if (request.method === "POST" && controlMatch) {
      const workflowRunId = decodeURIComponent(controlMatch[1])
      const action = controlMatch[2]
      const stopped = stopWorkflowRun(workflowRunId)
      sendJson(response, 200, {
        ok: true,
        [action === "cancel" ? "cancelled" : "stopped"]: stopped
      })
      return
    }

    // ---- /agent-runs/by-idempotency/:key/events?after=<cursor> ----------
    const eventsMatch = requestUrl.pathname.match(
      /^\/agent-runs\/by-idempotency\/(.+)\/events$/
    )
    if (request.method === "GET" && eventsMatch) {
      const idempotencyKey = decodeURIComponent(eventsMatch[1])
      const after = Number(requestUrl.searchParams.get("after") ?? 0)
      const runId =
        activeIdempotencyKeys.get(idempotencyKey) ??
        completedIdempotencyKeys.get(idempotencyKey)
      if (!runId) {
        sendJson(response, 404, {
          error: "agent run not found",
          idempotencyKey
        })
        return
      }
      sendJson(response, 200, readJournal(runId, after))
      return
    }

    // ---- /agent-runs/by-idempotency/:key --------------------------------
    const idempotencyMatch = requestUrl.pathname.match(
      /^\/agent-runs\/by-idempotency\/(.+)$/
    )
    if (request.method === "GET" && idempotencyMatch) {
      const idempotencyKey = decodeURIComponent(idempotencyMatch[1])
      const activeRunId = activeIdempotencyKeys.get(idempotencyKey)
      const completedRunId = completedIdempotencyKeys.get(idempotencyKey)

      if (activeRunId) {
        sendAgentRunStatus(response, activeRunId)
        return
      }
      if (completedRunId) {
        sendCompletedAgentRun(response, completedRunId)
        return
      }
      sendJson(response, 404, {
        error: "agent run not found",
        idempotencyKey
      })
      return
    }

    // ---- /agent-runs/:id -------------------------------------------------
    const agentRunMatch = requestUrl.pathname.match(
      /^\/agent-runs\/([^/]+)$/
    )
    if (request.method === "GET" && agentRunMatch) {
      const runId = decodeURIComponent(agentRunMatch[1])
      const completed = completedRuns.get(runId)
      if (completed) {
        sendCompletedAgentRun(response, runId)
        return
      }
      if (activeRuns.has(runId)) {
        sendAgentRunStatus(response, runId)
        return
      }
      sendJson(response, 404, { error: "agent run not found", id: runId })
      return
    }

    // ---- POST /agent-runs ------------------------------------------------
    if (request.method !== "POST" || requestUrl.pathname !== "/agent-runs") {
      sendJson(response, 404, { error: "not found" })
      return
    }

    const payload = await readJson(request)
    const protocolError = validateProtocol(payload)
    if (protocolError) {
      sendJson(response, 400, { error: protocolError })
      return
    }

    const idempotencyKey =
      payload.idempotencyKey || request.headers["idempotency-key"]

    if (idempotencyKey) {
      const activeRunId = activeIdempotencyKeys.get(idempotencyKey)
      if (activeRunId) {
        sendJson(response, 409, {
          error: "duplicate active idempotency key",
          id: activeRunId,
          idempotencyKey
        })
        return
      }
      const completedRunId = completedIdempotencyKeys.get(idempotencyKey)
      if (completedRunId) {
        sendCompletedAgentRun(response, completedRunId)
        return
      }
    }

    const runId = randomUUID()
    const startedAt = new Date().toISOString()
    const executor = payload.executor ?? "mavis"
    const workflowRunId = payload.workflowRunId

    appendJournal(runId, {
      type: "started",
      data: {
        executor,
        workflowRunId,
        title: payload.title,
        stage: payload.stage
      }
    })

    if (idempotencyKey) {
      activeIdempotencyKeys.set(idempotencyKey, runId)
    }

    // Insert a placeholder run record. The cancel function is replaced by
    // each backend before the request starts.
    activeRuns.set(runId, {
      id: runId,
      idempotencyKey,
      workflowRunId,
      cancel: () => {},
      startedAt,
      executor,
      payload
    })

    const prompt = buildPrompt(payload)

    let result
    try {
      if (a2aCommand) {
        result = await runA2ABackend({ id: runId, runId, payload, prompt })
      } else if (backendUrl) {
        result = await runHttpBackend({ id: runId, runId, payload, prompt })
      } else if (backendCommand) {
        result = await runCommandBackend({ runId, payload, prompt })
      } else {
        result = await runEchoBackend({ payload, prompt })
      }
    } catch (error) {
      result = {
        status: "failed",
        output: formatError(error),
        statusMessage: "minimax backend threw."
      }
    }

    const finishedAt = new Date().toISOString()
    const elapsedSeconds = Math.max(
      0,
      Math.round((Date.parse(finishedAt) - Date.parse(startedAt)) / 1000)
    )
    recordLuckyUsage(elapsedSeconds)

    if (result.status === "completed") {
      appendJournal(runId, { type: "completed", data: { length: (result.output ?? "").length } })
    } else if (result.status === "cancelled") {
      appendJournal(runId, { type: "failed", data: { reason: "cancelled", message: result.statusMessage } })
    } else {
      appendJournal(runId, { type: "failed", data: { message: result.statusMessage, output: result.output } })
    }

    const completedResponse = {
      id: runId,
      idempotencyKey,
      startedAt,
      finishedAt,
      capabilities: bridgeCapabilities(),
      quota: readLuckyQuota(),
      ...result
    }

    activeRuns.delete(runId)
    if (idempotencyKey) {
      activeIdempotencyKeys.delete(idempotencyKey)
    }
    rememberCompletedRun(runId, completedResponse)

    sendJson(response, 200, completedResponse)
  } catch (error) {
    sendJson(response, 500, { error: formatError(error) })
  }
})

function sendAgentRunStatus(response, runId) {
  const run = activeRuns.get(runId)
  if (!run) {
    sendJson(response, 404, { error: "agent run not found", id: runId })
    return
  }
  const journal = journalsByRunId.get(runId) ?? []
  sendJson(response, 200, {
    id: runId,
    idempotencyKey: run.idempotencyKey,
    status: "running",
    startedAt: run.startedAt,
    executor: run.executor,
    workflowRunId: run.workflowRunId,
    eventCount: journal.length
  })
}

function sendCompletedAgentRun(response, runId) {
  const snapshot = completedRuns.get(runId)
  if (!snapshot) {
    sendJson(response, 404, { error: "agent run not found", id: runId })
    return
  }
  sendJson(response, 200, snapshot)
}

// ---------- bootstrap ------------------------------------------------------

server.listen(port, host, () => {
  console.log(`minimax bridge listening at http://${host}:${port}`)
  console.log(`minimax model: ${defaultModel}`)
  console.log(`minimax A2A model: ${a2aModel}`)
  console.log(`minimax A2A agent: ${a2aAgent}`)
  if (a2aCommand) console.log(`minimax A2A command: ${a2aCommand}`)
  if (backendUrl) console.log(`minimax backend URL: ${backendUrl}`)
  if (backendCommand) console.log(`minimax backend command: ${backendCommand}`)
  if (!a2aCommand && !backendUrl && !backendCommand) {
    console.log("minimax backend: none configured; bridge will echo prompts.")
  }
  if (!token) {
    console.log("MINIMAX_BRIDGE_TOKEN is not set; bridge is loopback-only.")
  } else {
    console.log("minimax bridge auth: bearer token required")
  }
  console.log(
    `minimax quota window: ${luckyQuotaWindowSeconds}s (${(
      luckyQuotaWindowSeconds / 3600
    ).toFixed(1)}h)`
  )
})

// ---------- signal handling ------------------------------------------------

function shutdown(signal) {
  console.log(`minimax bridge received ${signal}; shutting down`)
  for (const [, run] of activeRuns.entries()) {
    try {
      run.cancel()
    } catch (error) {
      console.error(
        `minimax: cancel on shutdown failed: ${formatError(error)}`
      )
    }
  }
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 5_000).unref()
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
