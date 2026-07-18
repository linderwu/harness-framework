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

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { ok: true, repoRoot })
      return
    }

    if (request.method !== "POST" || request.url !== "/agent-runs") {
      sendJson(response, 404, { error: "not found" })
      return
    }

    if (token && request.headers.authorization !== `Bearer ${token}`) {
      sendJson(response, 401, { error: "invalid bridge token" })
      return
    }

    const payload = await readJson(request)
    const id = randomUUID()
    const startedAt = new Date().toISOString()
    const result = await runCodex(buildPrompt(payload), id)

    sendJson(response, 200, {
      id,
      startedAt,
      finishedAt: new Date().toISOString(),
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

async function runCodex(prompt, id) {
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
  const timer = setTimeout(() => child.kill("SIGTERM"), timeoutMs)

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

  const output = await fs.readFile(outputFile, "utf8").catch(() => "")
  await fs.unlink(outputFile).catch(() => {})

  return {
    status: exitCode === 0 ? "completed" : "failed",
    output: output.trim() || tail(stdout, 8000),
    stderr: tail(stderr, 8000)
  }
}

function buildPrompt(payload) {
  const skill = payload.skill ?? {}
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : []
  const artifactSummary = artifacts
    .map(
      (artifact) =>
        `## ${artifact.title ?? "Artifact"} (${artifact.type ?? "unknown"})\n${
          artifact.body ?? ""
        }`
    )
    .join("\n\n")

  return [
    "You are the local Codex executor for a Harness Framework workflow event.",
    "Handle only the event described below and respect its constraints.",
    "",
    `Project: ${payload.projectName ?? "unknown"}`,
    `Repository reference: ${payload.repository ?? "unknown"}`,
    `Workflow run: ${payload.workflowRunId ?? "unknown"}`,
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
    "Existing artifacts:",
    artifactSummary || "No prior artifacts.",
    "",
    "Return a concise final message that the harness can store as this event artifact."
  ].join("\n")
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
    if (raw.length > 2_000_000) {
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

function tail(value, maxLength) {
  return value.length > maxLength ? value.slice(value.length - maxLength) : value
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}
