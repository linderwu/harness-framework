import http from "node:http"
import os from "node:os"
import path from "node:path"
import { promises as fs } from "node:fs"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"

const host = process.env.CODEX_BRIDGE_HOST ?? "127.0.0.1"
const port = Number(process.env.CODEX_BRIDGE_PORT ?? 4177)
const token = process.env.HARNESS_BRIDGE_TOKEN
const repoRoot = path.resolve(
  process.env.CODEX_BRIDGE_REPO_ROOT ?? process.cwd()
)
const activeAgentRuns = new Map()
const activeWorkflowRuns = new Map()
const activeIdempotencyKeys = new Map()

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`
    )

    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, {
        ok: true,
        repoRoot,
        protocolVersion: "harness-agent-bridge/v0.2",
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
      const action = controlMatch[2]
      sendJson(response, 200, {
        ok: true,
        [action === "cancel" ? "cancelled" : "stopped"]:
          stopWorkflowRun(workflowRunId)
      })
      return
    }

    const agentRunMatch = requestUrl.pathname.match(/^\/agent-runs\/([^/]+)$/)

    if (request.method === "GET" && agentRunMatch) {
      const agentRunId = decodeURIComponent(agentRunMatch[1])
      const activeRun = activeAgentRuns.get(agentRunId)

      if (!activeRun) {
        sendJson(response, 404, { error: "agent run not active" })
        return
      }

      sendJson(response, 200, {
        id: agentRunId,
        workflowRunId: activeRun.workflowRunId,
        status: "running",
        startedAt: activeRun.startedAt,
        statusMessage: "Codex process is still running.",
        capabilities: bridgeCapabilities()
      })
      return
    }

    if (request.method !== "POST" || requestUrl.pathname !== "/agent-runs") {
      sendJson(response, 404, { error: "not found" })
      return
    }

    const payload = await readJson(request)
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
    const contextDir = await materializeContextFiles(payload.contextFiles, id)
    if (idempotencyKey) {
      activeIdempotencyKeys.set(idempotencyKey, id)
    }
    const result = await runCodex(
      buildPrompt(payload, contextDir),
      id,
      payload.workflowRunId
    ).finally(async () => {
      if (idempotencyKey) {
        activeIdempotencyKeys.delete(idempotencyKey)
      }
      if (contextDir) {
        await fs.rm(contextDir, { recursive: true, force: true }).catch(() => {})
      }
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
  console.log(`Codex bridge listening at http://${host}:${port}`)
  console.log(`Codex workspace: ${repoRoot}`)
  if (!token) {
    console.log("HARNESS_BRIDGE_TOKEN is not set; use localhost-only access.")
  }
})

async function runCodex(prompt, id, workflowRunId) {
  const outputFile = path.join(os.tmpdir(), `codex-bridge-${id}.txt`)
  const command = process.env.CODEX_BRIDGE_COMMAND ?? "codex"
  const sandbox = process.env.CODEX_BRIDGE_SANDBOX ?? "workspace-write"
  const serviceTier = process.env.CODEX_BRIDGE_SERVICE_TIER ?? "fast"
  const timeoutMs = Number(process.env.CODEX_BRIDGE_TIMEOUT_MS ?? 900000)
  const args = [
    "exec",
    "-c",
    `service_tier="${serviceTier}"`,
    "-C",
    repoRoot,
    "--skip-git-repo-check",
    "--sandbox",
    sandbox,
    "--output-last-message",
    outputFile,
    "-"
  ]

  const child = spawn(command, args, {
    cwd: repoRoot,
    shell: process.platform === "win32",
    stdio: ["pipe", "pipe", "pipe"]
  })

  let stdout = ""
  let stderr = ""
  const cancel = () => child.kill("SIGTERM")
  const timer = setTimeout(cancel, timeoutMs)
  activeAgentRuns.set(id, {
    cancel,
    startedAt: new Date().toISOString(),
    workflowRunId
  })

  if (workflowRunId) {
    activeWorkflowRuns.set(workflowRunId, id)
  }

  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString()
  })
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString()
  })
  child.stdin.end(prompt)

  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject)
    child.on("close", resolve)
  })
  clearTimeout(timer)
  activeAgentRuns.delete(id)

  if (workflowRunId) {
    activeWorkflowRuns.delete(workflowRunId)
  }

  const output = await fs.readFile(outputFile, "utf8").catch(() => "")
  await fs.unlink(outputFile).catch(() => {})

  return {
    status: exitCode === 0 ? "completed" : "failed",
    output: output.trim() || tail(stdout, 8000),
    stderr: tail(stderr, 8000),
    statusMessage:
      exitCode === 0
        ? "Codex completed."
        : `Codex exited with status ${exitCode}.`
  }
}

function stopWorkflowRun(workflowRunId) {
  const agentRunId = activeWorkflowRuns.get(workflowRunId)

  if (!agentRunId) {
    return false
  }

  return stopAgentRun(agentRunId)
}

function stopAgentRun(agentRunId) {
  const activeRun = activeAgentRuns.get(agentRunId)

  if (!activeRun) {
    return false
  }

  activeRun.cancel()
  return true
}

async function materializeContextFiles(contextFiles, id) {
  if (!Array.isArray(contextFiles) || contextFiles.length === 0) {
    return undefined
  }

  const contextDir = path.join(os.tmpdir(), `codex-bridge-context-${id}`)

  await fs.mkdir(contextDir, { recursive: true })

  for (const file of contextFiles) {
    const relativePath =
      sanitizeRelativePath(file.path || file.name || "file") || "file"
    const targetPath = path.join(contextDir, relativePath)

    await fs.mkdir(path.dirname(targetPath), { recursive: true })

    if (file.encoding === "base64") {
      await fs.writeFile(targetPath, Buffer.from(file.content ?? "", "base64"))
    } else {
      await fs.writeFile(targetPath, file.content ?? "", "utf8")
    }
  }

  return contextDir
}

function sanitizeRelativePath(value) {
  return value
    .replaceAll("\\", "/")
    .split("/")
    .filter((part) => part && part !== "." && part !== "..")
    .join("/")
}

function buildPrompt(payload, contextDir) {
  const skill = payload.skill ?? {}
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : []
  const contextFiles = Array.isArray(payload.contextFiles)
    ? payload.contextFiles
    : []
  const artifactSummary = artifacts
    .map(
      (artifact) =>
        `## ${artifact.title ?? "Artifact"} (${artifact.type ?? "unknown"})\n${
          artifact.body ?? ""
        }`
    )
    .join("\n\n")
  const contextSummary = contextFiles
    .map(
      (file) =>
        `- ${file.path ?? file.name ?? "file"} (${formatBytes(
          file.size ?? 0
        )}, ${file.encoding ?? "unknown"})`
    )
    .join("\n")

  return [
    "You are the local Codex executor for a Jormungandr workflow event.",
    "Handle only the event described below and respect its constraints.",
    "",
    `Project: ${payload.projectName ?? "unknown"}`,
    `Repository reference: ${payload.repository ?? "unknown"}`,
    `Workflow run: ${payload.workflowRunId ?? "unknown"}`,
    `Workflow version: ${payload.workflowVersion ?? "unknown"}`,
    `Idempotency key: ${payload.idempotencyKey ?? "none"}`,
    `Stage: ${payload.stage ?? "unknown"}`,
    `Requested artifact: ${payload.title ?? "Agent Artifact"}`,
    "",
    `Skill: ${skill.name ?? skill.id ?? "unknown"}`,
    `Purpose: ${skill.purpose ?? "unknown"}`,
    "",
    "Constraints:",
    ...asList(skill.constraints),
    "",
    "Inputs:",
    ...asList(skill.inputs),
    "",
    "Expected outputs:",
    ...asList(skill.outputs),
    "",
    "Original requirement:",
    payload.requirement ?? "",
    "",
    "Shared project files:",
    contextSummary || "No imported project files.",
    contextDir ? `Materialized file directory: ${contextDir}` : "",
    contextDir
      ? "All agents for this workflow run receive this same shared file set."
      : "",
    "",
    "Existing artifacts:",
    artifactSummary || "No prior artifacts.",
    "",
    "Return a concise final message that the harness can store as this event artifact."
  ].join("\n")
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB"]
  let size = value
  let unitIndex = 0

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024
    unitIndex += 1
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`
}

function asList(values) {
  return Array.isArray(values) && values.length > 0
    ? values.map((value) => `- ${value}`)
    : ["- none"]
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
  return ["cancel", "stop", "active-run-status", "idempotency-key", "text-output"]
}

function tail(value, maxLength) {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
