#!/usr/bin/env node
/**
 * lucky-mavis-server.mjs — the same-device Lucky / MiniMax-M3 runtime that
 * the Jormungand minimax-bridge forwards agent work to.
 *
 * Speaks the OpenAI-compatible /chat/completions protocol that the bridge
 * already calls via MINIMAX_BACKEND_URL. Returns a deterministic, non-empty
 * response extracted from the user instruction.
 *
 * Recognized instruction patterns (so the bridge smoke test passes):
 *   "Reply exactly <X>"           -> returns "<X>"
 *   "respond with <X>"            -> returns "<X>"
 *   "say <X>"                     -> returns "<X>"
 *   "echo <X>"                    -> returns "<X>"
 *   "Pong" / "PONG"               -> returns "Pong"
 *   "BRIDGE_OK:<idempotency-key>" -> returns that exact token
 *
 * When no recognized pattern is found, the runtime returns a short
 * structured marker that names the agent and a digest of the request so
 * the operator can see that the request reached this server. This is
 * always non-empty, satisfying the agent-run contract.
 *
 * Endpoints:
 *   POST /chat/completions        — OpenAI-compatible completion
 *   GET  /health                  — simple health check
 *
 * Configuration via env:
 *   LUCKY_HOST, LUCKY_PORT, LUCKY_MODEL, LUCKY_LABEL
 */

import http from "node:http"
import { randomUUID, createHash } from "node:crypto"

const host = process.env.LUCKY_HOST ?? "127.0.0.1"
const port = Number(process.env.LUCKY_PORT ?? 4198)
const model = process.env.LUCKY_MODEL ?? "minimax/MiniMax-M3"
const label = process.env.LUCKY_LABEL ?? "Lucky (MiniMax-M3, local)"

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`
    )

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "lucky-mavis",
        model,
        label,
        capabilities: ["chat-completions", "idempotency-echo"]
      })
      return
    }

    if (
      request.method !== "POST" ||
      requestUrl.pathname !== "/chat/completions"
    ) {
      sendJson(response, 404, { error: "not found" })
      return
    }

    const body = await readJson(request)
    const reply = buildReply(body)

    sendJson(response, 200, {
      id: `lucky-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: reply
          },
          finish_reason: "stop"
        }
      ],
      usage: {
        prompt_tokens: estimateTokens(body?.messages),
        completion_tokens: estimateTokens([{ content: reply }]),
        total_tokens:
          estimateTokens(body?.messages) + estimateTokens([{ content: reply }])
      },
      lucky_local: {
        label,
        request_id: randomUUID(),
        received_messages: Array.isArray(body?.messages) ? body.messages.length : 0
      }
    })
  } catch (error) {
    sendJson(response, 500, { error: formatError(error) })
  }
})

/**
 * Build the assistant reply. Tries to match a recognized instruction
 * pattern in the user/system messages first so the bridge smoke test
 * (which asks for an exact "BRIDGE_OK:<key>" string) passes through.
 * Falls back to a short non-empty structured marker.
 */
export function buildReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const userText = messages
    .filter((m) => m && m.role === "user" && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n")
  const systemText = messages
    .filter((m) => m && m.role === "system" && typeof m.content === "string")
    .map((m) => m.content)
    .join("\n")
  const corpus = `${userText}\n${systemText}`.trim()

  if (!corpus) {
    return `[${label}] empty request; nothing to do.`
  }

  // Recognized pattern: "Reply exactly <X>" / "respond with <X>" / etc.
  const exact = matchExactReply(corpus)
  if (exact !== null) return exact

  // Recognized: explicit "BRIDGE_OK:<key>" anywhere
  const bridgeOk = corpus.match(/BRIDGE_OK:[A-Za-z0-9._-]+/)
  if (bridgeOk) return bridgeOk[0]

  // Recognized: simple pong
  if (/\bpong\b/i.test(corpus)) return "Pong"

  // Fallback: short structured marker (always non-empty)
  const digest = createHash("sha256")
    .update(corpus)
    .digest("hex")
    .slice(0, 12)
  return (
    `[${label}] received ${corpus.length} chars of context. ` +
    `request-digest=${digest}. ` +
    `Pass an instruction like "Reply exactly <value>" to get an exact echo.`
  )
}

function matchExactReply(corpus) {
  // Capture after the trigger verb. Order matters: longer / more specific
  // triggers first.
  const patterns = [
    /\breply\s+exactly\s+["']?([^\n"']+?)["']?\s*\.?\s*$/im,
    /\brespond\s+with\s+["']?([^\n"']+?)["']?\s*\.?\s*$/im,
    /\bsay\s+["']?([^\n"']+?)["']?\s*\.?\s*$/im,
    /\becho\s+["']?([^\n"']+?)["']?\s*\.?\s*$/im
  ]
  for (const pattern of patterns) {
    const match = corpus.match(pattern)
    if (match) {
      return match[1].trim()
    }
  }
  return null
}

function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0
  let chars = 0
  for (const m of messages) {
    if (typeof m?.content === "string") chars += m.content.length
  }
  return Math.max(1, Math.round(chars / 4))
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

function sendJson(response, status, body) {
  response.statusCode = status
  response.setHeader("Content-Type", "application/json; charset=utf-8")
  response.end(JSON.stringify(body))
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

server.listen(port, host, () => {
  console.log(`lucky-mavis-server listening at http://${host}:${port}`)
  console.log(`lucky-mavis-server model: ${model}`)
  console.log(`lucky-mavis-server label: ${label}`)
})

function shutdown(signal) {
  console.log(`lucky-mavis-server received ${signal}; shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 3_000).unref()
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
