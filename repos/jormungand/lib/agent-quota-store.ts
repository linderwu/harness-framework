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

  const [codexQuota, luckyQuota] = await Promise.all([
    getCodexQuota(),
    getLuckyQuota()
  ])

  // OpenClaw agents share the same minimax account as Lucky, so all five
  // cards on openclaw-bridge display the identical 5h quota bar. We clone
  // luckyQuota per agent so each AgentQuota entry has the right agentId.
  const openclawProfiles = agentProfiles.filter(
    (profile) => profile.family === "openclaw"
  )
  const openclawQuotas: AgentQuota[] = openclawProfiles.map((profile) => ({
    ...luckyQuota,
    agentId: profile.id as AgentKind,
    provider: "minimax"
  }))

  return [codexQuota, luckyQuota, ...openclawQuotas]
}
