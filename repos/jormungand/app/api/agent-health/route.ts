import { NextResponse } from "next/server"

type BridgeHealthStatus = "online" | "offline"

interface BridgeHealth {
  id: "codex-bridge" | "openclaw-bridge"
  label: string
  status: BridgeHealthStatus
  urlHost: string
  protocolVersion?: string
  capabilities?: string[]
  message?: string
}

const healthTimeoutMs = 2500

export async function GET() {
  const bridgeChecks = [
    createHttpBridgeCheck({
      id: "codex-bridge",
      label: "寶可夢中心",
      url: process.env.CODEX_BRIDGE_URL,
      token: process.env.CODEX_BRIDGE_TOKEN
    }),
    createHttpBridgeCheck({
      id: "openclaw-bridge",
      label: "Linder的寶貝球",
      url: process.env.OPENCLAW_BRIDGE_URL,
      token:
        process.env.OPENCLAW_BRIDGE_TOKEN?.trim() ||
        process.env.OPENCLAW_GATEWAY_TOKEN?.trim()
    }),
  ].filter((check): check is HttpBridgeCheck => Boolean(check))
  const bridges = await Promise.all(bridgeChecks.map(checkHttpBridge))

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    bridges
  })
}

interface HttpBridgeCheck {
  id: BridgeHealth["id"]
  label: string
  url: string
  token?: string
  urlHost: string
}

function createHttpBridgeCheck(input: {
  id: BridgeHealth["id"]
  label: string
  url?: string
  token?: string
}): HttpBridgeCheck | undefined {
  if (!input.url) {
    return undefined
  }

  const url = coerceBridgeUrl(input.url)
  if (!url) {
    return undefined
  }

  let urlHost: string
  try {
    urlHost = new URL(url).host
  } catch {
    return undefined
  }

  return {
    id: input.id,
    label: input.label,
    url,
    token: input.token,
    urlHost
  }
}

/**
 * Coerce a raw bridge URL into a string that URL() can parse.
 * Accepts values with or without an explicit scheme. If the scheme is
 * missing, defaults to https:// (the common case for bridge backends).
 * Returns undefined for empty or unparseable values.
 */
function coerceBridgeUrl(raw: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) return trimmed
  return `https://${trimmed}`
}

async function checkHttpBridge(input: HttpBridgeCheck): Promise<BridgeHealth> {
  try {
    const response = await fetch(new URL("health", normalizeUrl(input.url)), {
      cache: "no-store",
      headers: input.token ? { Authorization: `Bearer ${input.token}` } : {},
      signal: AbortSignal.timeout(healthTimeoutMs)
    })
    const data = (await response.json().catch(() => ({}))) as {
      protocolVersion?: string
      capabilities?: string[]
      error?: string
    }

    return {
      id: input.id,
      label: input.label,
      status: response.ok ? "online" : "offline",
      urlHost: input.urlHost,
      protocolVersion: data.protocolVersion,
      capabilities: data.capabilities,
      message: response.ok
        ? "Health check succeeded."
        : data.error ?? `Health check failed with HTTP ${response.status}.`
    }
  } catch (error) {
    return {
      id: input.id,
      label: input.label,
      status: "offline",
      urlHost: input.urlHost,
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}
