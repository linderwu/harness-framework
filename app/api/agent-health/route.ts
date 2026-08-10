import { NextResponse } from "next/server"

type BridgeHealthStatus = "online" | "offline" | "not_configured"

interface BridgeHealth {
  id: "codex-bridge" | "openclaw-bridge" | "openclaw-a2a" | "manual"
  label: string
  status: BridgeHealthStatus
  protocolVersion?: string
  capabilities?: string[]
  message?: string
}

const healthTimeoutMs = 2500

export async function GET() {
  const bridges = await Promise.all([
    checkHttpBridge({
      id: "codex-bridge",
      label: "Codex Bridge",
      url: process.env.CODEX_BRIDGE_URL,
      token: process.env.CODEX_BRIDGE_TOKEN
    }),
    checkHttpBridge({
      id: "openclaw-bridge",
      label: "OpenClaw Bridge",
      url: process.env.OPENCLAW_BRIDGE_URL,
      token: process.env.OPENCLAW_BRIDGE_TOKEN
    }),
    checkCommandBridge({
      id: "openclaw-a2a",
      label: "OpenClaw A2A",
      command: process.env.OPENCLAW_A2A_COMMAND
    }),
    {
      id: "manual",
      label: "Manual / Simulated",
      status: "online",
      message: "Manual and simulated runs do not require a network bridge."
    } satisfies BridgeHealth
  ])

  return NextResponse.json({
    checkedAt: new Date().toISOString(),
    bridges
  })
}

async function checkHttpBridge(input: {
  id: BridgeHealth["id"]
  label: string
  url?: string
  token?: string
}): Promise<BridgeHealth> {
  if (!input.url) {
    return {
      id: input.id,
      label: input.label,
      status: "not_configured",
      message: "Bridge URL is not configured."
    }
  }

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
      message: error instanceof Error ? error.message : String(error)
    }
  }
}

function checkCommandBridge(input: {
  id: BridgeHealth["id"]
  label: string
  command?: string
}): BridgeHealth {
  if (!input.command) {
    return {
      id: input.id,
      label: input.label,
      status: "not_configured",
      message: "A2A command is not configured."
    }
  }

  return {
    id: input.id,
    label: input.label,
    status: "online",
    message: "A2A command is configured."
  }
}

function normalizeUrl(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}
