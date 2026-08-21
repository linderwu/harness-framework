#!/usr/bin/env node
/**
 * mavis-local-server.mjs — a small OpenAI-compatible chat completions
 * server that stands in for the real Mavis / MiniMax-M3 endpoint during
 * local development. The minimax-bridge calls this via
 * MINIMAX_BACKEND_URL=http://127.0.0.1:4100.
 *
 * Endpoints:
 *   POST /chat/completions        — OpenAI-compatible completion
 *   GET  /health                  — simple health check
 *
 * The response is generated deterministically from the incoming prompt
 * so the round-trip is easy to inspect in tests. It echoes the system +
 * user prompt back, wrapped with a marker that proves the request
 * reached this server, and adds a small structured footer describing
 * what the server received.
 */

import http from "node:http"
import { randomUUID } from "node:crypto"

const host = process.env.MAVIS_LOCAL_HOST ?? "127.0.0.1"
const port = Number(process.env.MAVIS_LOCAL_PORT ?? 4100)
const serverLabel = process.env.MAVIS_LOCAL_LABEL ?? "Mavis (local dev)"

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? `${host}:${port}`}`
    )

    if (request.method === "GET" && requestUrl.pathname === "/health") {
      sendJson(response, 200, {
        ok: true,
        service: "mavis-local",
        model: process.env.MAVIS_LOCAL_MODEL ?? "minimax/MiniMax-M3",
        label: serverLabel
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
      id: `mavis-local-${randomUUID()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model: body?.model ?? "minimax/MiniMax-M3",
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
        total_tokens: estimateTokens(body?.messages) + estimateTokens([{ content: reply }])
      },
      mavis_local: {
        label: serverLabel,
        request_id: randomUUID(),
        received_messages: Array.isArray(body?.messages) ? body.messages.length : 0
      }
    })
  } catch (error) {
    sendJson(response, 500, { error: formatError(error) })
  }
})

function buildReply(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  const systemMsgs = messages.filter((m) => m?.role === "system")
  const userMsgs = messages.filter((m) => m?.role === "user")
  const lastUser =
    userMsgs.length > 0 ? String(userMsgs[userMsgs.length - 1].content ?? "") : ""

  const lines = []
  lines.push(`[${serverLabel}] got your request.`)
  lines.push("")
  lines.push(`Model requested: ${body?.model ?? "(default)"}`)
  lines.push(`Messages received: ${messages.length} (${systemMsgs.length} system, ${userMsgs.length} user)`)
  if (lastUser) {
    const preview = lastUser.length > 240 ? `${lastUser.slice(0, 240)}…` : lastUser
    lines.push("")
    lines.push("Last user message (truncated to 240 chars):")
    lines.push("```")
    lines.push(preview)
    lines.push("```")
  }
  lines.push("")
  lines.push(
    "This is a local stand-in for the real Mavis / MiniMax-M3 endpoint. " +
      "It is not a real LLM. It exists to verify the minimax-bridge wire " +
      "protocol end-to-end without needing a hosted Mavis API or a working " +
      "remote bridge at jormungandcycle.com."
  )
  return lines.join("\n")
}

function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0
  // Naive word count / 0.75 is the standard OpenAI approximation.
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
  console.log(`mavis-local listening at http://${host}:${port}`)
  console.log(`mavis-local model: ${process.env.MAVIS_LOCAL_MODEL ?? "minimax/MiniMax-M3"}`)
  console.log(`mavis-local label: ${serverLabel}`)
})

function shutdown(signal) {
  console.log(`mavis-local received ${signal}; shutting down`)
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 3_000).unref()
}

process.on("SIGINT", () => shutdown("SIGINT"))
process.on("SIGTERM", () => shutdown("SIGTERM"))
