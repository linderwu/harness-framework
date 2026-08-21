import http from "node:http"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

const host = process.env.MINIMAX_BRIDGE_HOST ?? "127.0.0.1"
const port = Number(process.env.MINIMAX_BRIDGE_PORT ?? 3002)
const token =
  process.env.MINIMAX_BRIDGE_TOKEN?.trim() ||
  process.env.HARNESS_BRIDGE_TOKEN?.trim() ||
  process.env.MINIMAX_GATEWAY_TOKEN?.trim()
const backendUrl = process.env.MINIMAX_BACKEND_URL?.trim()
const backendCommand = process.env.MINIMAX_BACKEND_COMMAND?.trim()
const defaultModel = process.env.MINIMAX_BACKEND_MODEL ?? "minimax/MiniMax-M2.7"
const protocolVersion = "harness-agent-bridge/v0.3"
const bridgeTimeoutMs = Number(process.env.MINIMAX_BRIDGE_TIMEOUT_MS ?? 900000)

const activeRuns = new Map()
const activeIdempotencyKeys = new Map()
const completedIdempotencyRuns = new Map()

if (!isLoopbackHost(host) && !token) {
  throw new Error("MINIMAX_BRIDGE_TOKEN is required for non-loopback binding")
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`
    )

    if (token && request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: "invalid bridge token" })
      return
    }

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        protocolVersion,
        capabilities: bridgeCapabilities(),
        model: defaultModel,
        backend: backendUrl
          ? `http:${backendUrl}`
          : backendCommand
          ? `command:${backendCommand}`
          : "echo"
      })
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

    const idempotencyMatch = requestUrl.pathname.match(
      /^\/agent-runs\/by-idempotency\/(.+)$/
    )

    if (request.method === "GET" && idempotencyMatch) {
      const idempotencyKey = decodeURIComponent(idempotencyMatch[1])
      const activeRunId = activeIdempotencyKeys.get(idempotencyKey)
      const completedRun = completedIdempotencyRuns.get(idempotencyKey)

      if (activeRunId) {
        sendJson(response, 200, {
          id: activeRunId,
          idempotencyKey,
          status: "running"
        })
        return
      }

      if (completedRun) {
        sendJson(response, 200, completedRun)
        return
      }

      sendJson(response, 404, { error: "agent run not found", idempotencyKey })
      return
    }

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

    if (idempotencyKey && activeIdempotencyKeys.has(idempotencyKey)) {
      sendJson(response, 409, {
        error: "duplicate active idempotency key",
        id: activeIdempotencyKeys.get(idempotencyKey),
        idempotencyKey
      })
      return
    }

    const id = randomUUID()
    const startedAt = new Date().toISOString()

    if (idempotencyKey) {
      activeIdempotencyKeys.set(idempotencyKey, id)
    }

    const executor = payload.executor ?? "minimax"
    const workflowRunId = payload.workflowRunId
    const cancel = () => {}
    activeRuns.set(id, { cancel, workflowRunId })

    let result
    try {
      result = await runMinimaxAgent({
        id,
        executor,
        payload
      })
    } finally {
      activeRuns.delete(id)
      if (idempotencyKey) {
        activeIdempotencyKeys.delete(idempotencyKey)
      }
    }

    const completedResponse = {
      id,
      idempotencyKey,
      startedAt,
      finishedAt: new Date().toISOString(),
      capabilities: bridgeCapabilities(),
      ...result
    }
    rememberCompletedRun(idempotencyKey, completedResponse)
    sendJson(response, 200, completedResponse)
  } catch (error) {
    sendJson(response, 500, { error: formatError(error) })
  }
})

server.listen(port, host, () => {
  console.log(`minimax bridge listening at http://${host}:${port}`)
  console.log(`minimax model: ${defaultModel}`)
  if (backendUrl) console.log(`minimax backend URL: ${backendUrl}`)
  if (backendCommand) console.log(`minimax backend command: ${backendCommand}`)
  if (!backendUrl && !backendCommand) {
    console.log(
      "minimax backend: none configured; bridge echoes input (set MINIMAX_BACKEND_URL or MINIMAX_BACKEND_COMMAND)."
    )
  }
  if (!token) {
    console.log("MINIMAX_BRIDGE_TOKEN is not set; bridge is loopback-only.")
  }
})

async function runMinimaxAgent({ id, executor, payload }) {
  const prompt = buildMinimaxPrompt(payload)
  if (backendUrl) {
    return invokeHttpBackend({ executor, payload, prompt })
  }
  if (backendCommand) {
    return invokeCommandBackend({ executor, payload, prompt })
  }
  return {
    status: "completed",
    output: prompt,
    statusMessage: "minimax bridge has no backend configured; echoed prompt back."
  }
}

function buildMinimaxPrompt(payload) {
  const parts = []
  parts.push(`You are ${payload.executor ?? "minimax"} on the Jormungand harness.`)
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

async function invokeHttpBackend({ executor, payload, prompt }) {
  const url = backendUrl.endsWith("/")
    ? `${backendUrl}chat/completions`
    : `${backendUrl}/chat/completions`
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(process.env.MINIMAX_BACKEND_TOKEN
        ? { Authorization: `Bearer ${process.env.MINIMAX_BACKEND_TOKEN}` }
        : {})
    },
    body: JSON.stringify({
      model: defaultModel,
      messages: [
        { role: "system", content: `You are ${executor} on the Jormungand harness.` },
        { role: "user", content: prompt }
      ]
    }),
    signal: AbortSignal.timeout(bridgeTimeoutMs)
  }).catch((error) => {
    throw new Error(`minimax backend HTTP request failed: ${formatError(error)}`)
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) {
    return {
      status: "failed",
      output: data?.error?.message ?? data?.error ?? `HTTP ${response.status}`,
      statusMessage: `minimax backend returned HTTP ${response.status}.`
    }
  }
  const output =
    data?.choices?.[0]?.message?.content ??
    data?.output ??
    data?.text ??
    JSON.stringify(data)
  return {
    status: "completed",
    output,
    statusMessage: `minimax backend completed via HTTP.`
  }
}

async function invokeCommandBackend({ executor, payload, prompt }) {
  const child = spawn(backendCommand, {
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      MINIMAX_AGENT: executor,
      MINIMAX_MODEL: defaultModel,
      MINIMAX_PROMPT: prompt
    }
  })
  let stdout = ""
  let stderr = ""
  const timer = setTimeout(() => child.kill("SIGTERM"), bridgeTimeoutMs)
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  child.stdin.end(
    JSON.stringify({
      agent: executor,
      model: defaultModel,
      prompt,
      payload
    })
  )
  let exitCode = 1
  try {
    exitCode = await new Promise((resolve, reject) => {
      child.on("error", reject)
      child.on("close", (code) => resolve(code ?? 1))
    })
  } finally {
    clearTimeout(timer)
  }
  if (exitCode !== 0) {
    return {
      status: "failed",
      output: stderr || stdout || `command exited with ${exitCode}`,
      statusMessage: `minimax backend command exited with ${exitCode}.`
    }
  }
  return {
    status: "completed",
    output: stdout.trim() || "(no output)",
    statusMessage: `minimax backend command completed.`
  }
}

function bridgeCapabilities() {
  return [
    "cancel",
    "stop",
    "active-run-status",
    "idempotency-key",
    "text-output",
    "runtime-skill-bundles"
  ]
}

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

function stopWorkflowRun(workflowRunId) {
  let stopped = 0
  for (const [id, run] of activeRuns.entries()) {
    if (run.workflowRunId === workflowRunId) {
      try {
        run.cancel()
      } catch (error) {
        console.error(`failed to cancel ${id}: ${formatError(error)}`)
      }
      stopped += 1
    }
  }
  return stopped
}

function rememberCompletedRun(idempotencyKey, response) {
  if (!idempotencyKey) return
  completedIdempotencyRuns.set(idempotencyKey, response)
  setTimeout(() => {
    if (completedIdempotencyRuns.get(idempotencyKey) === response) {
      completedIdempotencyRuns.delete(idempotencyKey)
    }
  }, 30 * 60 * 1000)
}

function isLoopbackHost(value) {
  return value === "127.0.0.1" || value === "localhost" || value === "::1"
}

function sendJson(response, status, body) {
  response.statusCode = status
  response.setHeader("Content-Type", "application/json")
  response.end(JSON.stringify(body))
}

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

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
