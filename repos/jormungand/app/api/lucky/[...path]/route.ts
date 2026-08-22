import { NextResponse } from "next/server"

/**
 * /api/lucky/[...path] — a thin Next.js forwarder through the shared
 * codex-bridge device endpoint. The codex-bridge forwards Mavis requests to
 * the same-device lucky-mavis-server, so this catch-all is for client-side
 * (browser) calls — e.g.
 * a future "chat with Lucky" panel — and any other code that prefers the
 * same-origin route over a separate host:port.
 *
 *   GET  /api/lucky/health            -> GET <server>/health
 *   GET  /api/lucky/agent-quota       -> GET <server>/agent-quota
 *   POST /api/lucky/agent-runs        -> POST <server>/agent-runs
 *   GET  /api/lucky/agent-runs/...    -> GET <server>/agent-runs/...
 *   POST /api/lucky/workflow-runs/:id/(cancel|stop)
 *                                       -> POST <server>/workflow-runs/...
 *
 * Auth: passes CODEX_BRIDGE_TOKEN on the way through.
 */

const SERVER_TIMEOUT_MS = Number(
  process.env.CODEX_BRIDGE_PROXY_TIMEOUT_MS ?? 900_000
)

function getServerBase(): string {
  return process.env.CODEX_BRIDGE_URL ?? "http://127.0.0.1:4177"
}

function getServerToken(): string | undefined {
  return process.env.CODEX_BRIDGE_TOKEN?.trim() || undefined
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { Accept: "application/json" }
  const token = getServerToken()
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

function buildTarget(path: string[], requestUrl: string): URL {
  const base = getServerBase()
  const tail = path.join("/")
  const queryIndex = requestUrl.indexOf("?")
  const search = queryIndex >= 0 ? requestUrl.slice(queryIndex) : ""
  return new URL(tail + search, base.endsWith("/") ? base : `${base}/`)
}

async function forward(request: Request, path: string[]): Promise<Response> {
  const target = buildTarget(path, request.url)
  const init: RequestInit = {
    method: request.method,
    headers: {
      ...Object.fromEntries(request.headers.entries()),
      ...authHeaders()
    },
    cache: "no-store",
    signal: AbortSignal.timeout(SERVER_TIMEOUT_MS)
  }
  if (
    request.method === "POST" ||
    request.method === "PUT" ||
    request.method === "PATCH"
  ) {
    init.body = await request.text()
  }
  let response: Response
  try {
    response = await fetch(target, init)
  } catch (error) {
    return NextResponse.json(
      {
        error: `codex-bridge unreachable at ${getServerBase()}: ${
          error instanceof Error ? error.message : String(error)
        }`
      },
      { status: 502 }
    )
  }
  const text = await response.text()
  const headers = new Headers()
  headers.set(
    "Content-Type",
    response.headers.get("Content-Type") ?? "application/json"
  )
  return new NextResponse(text, { status: response.status, headers })
}

export async function GET(
  request: Request,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  return forward(request, path)
}

export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  return forward(request, path)
}

export async function PUT(
  request: Request,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  return forward(request, path)
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ path: string[] }> }
) {
  const { path } = await context.params
  return forward(request, path)
}
