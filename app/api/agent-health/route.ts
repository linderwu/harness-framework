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
      label: "Codex Bridge",
      url: process.env.CODEX_BRIDGE_URL,
      token: process.env.CODEX_BRIDGE_TOKEN
    }),
    createHttpBridgeCheck({
      id: "openclaw-bridge",
      label: "OpenClaw Bridge",
      url: process.env.OPENCLAW_BRIDGE_URL,
      token: process.env.OPENCLAW_BRIDGE_TOKEN
    })
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

  return {
    id: input.id,
    label: input.label,
    url: input.url,
    token: input.token,
    urlHost: new URL(input.url).host
  }
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
