import { agentProfiles } from "@/lib/agents"
import { calculateQuotaState, type AgentQuota } from "@/lib/agent-quota"
import type { AgentKind } from "@/lib/types"

function nextMondayUtc(now: Date) {
  const reset = new Date(now)
  const daysUntilMonday = (8 - reset.getUTCDay()) % 7 || 7
  reset.setUTCDate(reset.getUTCDate() + daysUntilMonday)
  reset.setUTCHours(0, 0, 0, 0)
  return reset.toISOString()
}

async function getCodexQuota(): Promise<AgentQuota> {
  const now = new Date().toISOString()
  const bridgeUrl = process.env.CODEX_BRIDGE_URL ?? "http://127.0.0.1:4177"
  const headers: HeadersInit = {}
  if (process.env.CODEX_BRIDGE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.CODEX_BRIDGE_TOKEN}`
  }

  try {
    const response = await fetch(`${bridgeUrl.replace(/\/$/, "")}/agent-quota`, {
      headers,
      cache: "no-store"
    })
    if (!response.ok) throw new Error(`Codex bridge returned ${response.status}`)
    return (await response.json()) as AgentQuota
  } catch {
    return {
      agentId: "codex",
      provider: "Codex",
      model: "ChatGPT OAuth",
      weeklyLimit: 100,
      weeklyUsed: 0,
      weeklyRemaining: 0,
      remainingPercent: 0,
      unit: "percent",
      resetAt: now,
      updatedAt: now,
      status: "unavailable"
    }
  }
}

async function getLuckyQuota(): Promise<AgentQuota> {
  const now = new Date().toISOString()
  const bridgeUrl = process.env.CODEX_BRIDGE_URL ?? "http://127.0.0.1:4177"
  const headers: HeadersInit = {}
  if (process.env.CODEX_BRIDGE_TOKEN) {
    headers.Authorization = `Bearer ${process.env.CODEX_BRIDGE_TOKEN}`
  }

  try {
    const response = await fetch(
      `${bridgeUrl.replace(/\/$/, "")}/agent-quota?executor=mavis`,
      { headers, cache: "no-store" }
    )
    if (!response.ok) throw new Error(`Codex bridge returned ${response.status}`)
    return (await response.json()) as AgentQuota
  } catch {
    return {
      agentId: "mavis",
      provider: "minimax",
      model: "minimax/MiniMax-M3",
      weeklyLimit: 5 * 3600,
      weeklyUsed: 0,
      weeklyRemaining: 5 * 3600,
      remainingPercent: 100,
      unit: "seconds",
      resetAt: now,
      updatedAt: now,
      status: "unavailable"
    }
  }
}

export async function getAgentQuotas(): Promise<AgentQuota[]> {
  const now = new Date()
  const resetAt = nextMondayUtc(now)

  const quotas = agentProfiles.map((profile, index): AgentQuota | null => {
    if (profile.id === "codex" || profile.id === "mavis") return null
    const weeklyLimit = 100000
    const weeklyUsed = [18000, 42000, 76000, 93000, 1000, 51000][index] ?? 0
    const updatedAt = now.toISOString()
    const state = calculateQuotaState({ weeklyLimit, weeklyUsed, updatedAt })

    return {
      agentId: profile.id as AgentKind,
      provider: profile.family === "openclaw" ? "OpenClaw" : "Manual",
      model: "Configured model",
      weeklyLimit,
      weeklyUsed,
      ...state,
      unit: "tokens",
      resetAt,
      updatedAt
    }
  }).filter((quota): quota is AgentQuota => quota !== null)

  const [codexQuota, luckyQuota] = await Promise.all([
    getCodexQuota(),
    getLuckyQuota()
  ])
  return [codexQuota, luckyQuota, ...quotas]
}
