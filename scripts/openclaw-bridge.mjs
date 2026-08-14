import http from "node:http"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"

const host = process.env.OPENCLAW_BRIDGE_HOST ?? "127.0.0.1"
const port = Number(process.env.OPENCLAW_BRIDGE_PORT ?? 4188)
const token = process.env.OPENCLAW_BRIDGE_TOKEN ?? process.env.HARNESS_BRIDGE_TOKEN
const container = process.env.OPENCLAW_CONTAINER ?? "openclaw"
const defaultModel = process.env.OPENCLAW_A2A_MODEL ?? "minimax-portal/MiniMax-M2.7"
const siteAuth = loadSiteAuth()
const activeRuns = new Map()
const activeWorkflowRuns = new Map()

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`
    )

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        protocolVersion: "harness-openclaw-bridge/v0.1",
        container,
        capabilities: bridgeCapabilities()
      })
      return
    }

    if (token && request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: "invalid bridge token" })
      return
    }

    const controlMatch = requestUrl.pathname.match(
      /^\/workflow-runs\/([^/]+)\/(cancel|stop)$/
    )

    if (request.method === "POST" && controlMatch) {
      const workflowRunId = decodeURIComponent(controlMatch[1])
      const stopped = stopWorkflowRun(workflowRunId)
      sendJson(response, 200, {
        ok: true,
        [controlMatch[2] === "cancel" ? "cancelled" : "stopped"]: stopped
      })
      return
    }

    if (request.method !== "POST" || requestUrl.pathname !== "/agent-runs") {
      sendJson(response, 404, { error: "not found" })
      return
    }

    const payload = await readJson(request)
    const id = randomUUID()
    const startedAt = new Date().toISOString()
    const idempotencyKey =
      payload.idempotencyKey || request.headers["idempotency-key"] || id
    const mainAgent = normalizeOpenClawAgent(payload.mainAgent, payload.executor)
    const model = resolveModel(mainAgent)
    const sessionKey = `agent:${mainAgent}:harness-${payload.workflowRunId ?? id}`
    const message = buildOpenClawMessage(payload, {
      id,
      idempotencyKey,
      mainAgent,
      model,
      sessionKey
    })
    const result = await runOpenClawAgent({
      id,
      workflowRunId: payload.workflowRunId,
      mainAgent,
      model,
      sessionKey,
      message
    })

    sendJson(response, 200, {
      id,
      idempotencyKey,
      startedAt,
      finishedAt: new Date().toISOString(),
      capabilities: bridgeCapabilities(),
      ...result
    })
  } catch (error) {
    sendJson(response, 500, { error: formatError(error) })
  }
})

server.listen(port, host, () => {
  console.log(`OpenClaw bridge listening at http://${host}:${port}`)
  console.log(`OpenClaw container: ${container}`)
  if (!token) {
    console.log("OPENCLAW_BRIDGE_TOKEN is not set; keep this bridge private.")
  }
})

async function runOpenClawAgent({
  id,
  workflowRunId,
  mainAgent,
  model,
  sessionKey,
  message
}) {
  const args = [
    "exec",
    ...(siteAuth.username && siteAuth.password
      ? [
          "-e",
          `SITE_AUTH_USERNAME=${siteAuth.username}`,
          "-e",
          `SITE_AUTH_PASSWORD=${siteAuth.password}`
        ]
      : []),
    container,
    "openclaw",
    "agent",
    "--agent",
    mainAgent,
    "--model",
    model,
    "--session-key",
    sessionKey,
    "--message",
    message,
    "--json",
    "--timeout",
    String(Number(process.env.OPENCLAW_AGENT_TIMEOUT_SECONDS ?? 600))
  ]
  const child = spawn("docker", args, {
    stdio: ["ignore", "pipe", "pipe"]
  })
  let stdout = ""
  let stderr = ""
  const timeoutMs = Number(process.env.OPENCLAW_BRIDGE_TIMEOUT_MS ?? 900000)
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)

  activeRuns.set(id, { cancel: () => child.kill("SIGTERM"), workflowRunId })
  if (workflowRunId) {
    activeWorkflowRuns.set(workflowRunId, id)
  }

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", (code) => resolve(code ?? 1))
  })
  clearTimeout(timer)
  activeRuns.delete(id)
  if (workflowRunId) {
    activeWorkflowRuns.delete(workflowRunId)
  }

  return {
    status: exitCode === 0 ? "completed" : "failed",
    output: extractOpenClawText(stdout).trim() || tail(stdout, 8000),
    stderr: tail(stderr, 8000),
    statusMessage:
      exitCode === 0
        ? `${mainAgent} completed through OpenClaw bridge.`
        : `${mainAgent} exited with status ${exitCode}.`
  }
}

function loadSiteAuth() {
  const values = {
    username: process.env.SITE_AUTH_USERNAME ?? "",
    password: process.env.SITE_AUTH_PASSWORD ?? ""
  }
  const filePath = process.env.OPENCLAW_SITE_AUTH_FILE

  if (!filePath) {
    return values
  }

  try {
    for (const line of readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const separator = line.indexOf("=")
      if (separator < 1) {
        continue
      }
      const key = line.slice(0, separator)
      const value = line.slice(separator + 1)
      if (key === "SITE_AUTH_USERNAME") values.username = value
      if (key === "SITE_AUTH_PASSWORD") values.password = value
    }
  } catch {}

  return values
}

function stopWorkflowRun(workflowRunId) {
  const runId = activeWorkflowRuns.get(workflowRunId)

  if (!runId) {
    return false
  }

  const activeRun = activeRuns.get(runId)

  if (!activeRun) {
    return false
  }

  activeRun.cancel()
  return true
}

function buildOpenClawMessage(payload, context) {
  return JSON.stringify({
    protocol: "ClawCodex-A2A",
    version: "0.1",
    msg_id: context.idempotencyKey,
    in_reply_to: null,
    from: "jormungandr",
    to: `openclaw:${context.mainAgent}`,
    intent: "task",
    summary: payload.title ?? "Harness workflow event",
    body: {
      workflowRunId: payload.workflowRunId,
      workflowVersion: payload.workflowVersion,
      projectName: payload.projectName,
      repository: payload.repository,
      requirement: payload.requirement,
      stage: payload.stage,
      artifactType: payload.artifactType,
      title: payload.title,
      executor: payload.executor,
      skill: payload.skill,
      artifacts: payload.artifacts ?? [],
      fallbackBody: payload.fallbackBody
    },
    artifacts: [],
    requested_action: "reply",
    constraints: payload.skill?.constraints ?? [],
    status: "accepted",
    transport: {
      bridgeRunId: context.id,
      sessionKey: context.sessionKey,
      model: context.model
    }
  })
}

function normalizeOpenClawAgent(mainAgent, executor) {
  const value = mainAgent || String(executor ?? "").replace(/^openclaw\./, "")

  if (["rowlet", "roaringmoon", "charizard", "mrmime", "mrmine", "gengar"].includes(value)) {
    return value
  }

  return "rowlet"
}

function resolveModel(mainAgent) {
  const envKey = `OPENCLAW_${mainAgent.toUpperCase()}_MODEL`

  if (process.env[envKey]) {
    return process.env[envKey]
  }

  if (mainAgent === "charizard") {
    return "minimax-portal/MiniMax-M3"
  }

  return defaultModel
}

function extractOpenClawText(raw) {
  try {
    const data = JSON.parse(raw)
    return (
      data?.result?.payloads
        ?.map((payload) => payload.text)
        .filter(Boolean)
        .join("\n") || raw
    )
  } catch {
    return raw
  }
}

async function readJson(request) {
  let raw = ""

  for await (const chunk of request) {
    raw += chunk.toString()
    if (raw.length > 50_000_000) {
      throw new Error("request body too large")
    }
  }

  return JSON.parse(raw)
}

function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  })
  response.end(JSON.stringify(body))
}

function bridgeCapabilities() {
  return [
    "openclaw-agent",
    "cancel",
    "stop",
    "idempotency-key",
    "text-output"
  ]
}

function tail(value, maxLength) {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
