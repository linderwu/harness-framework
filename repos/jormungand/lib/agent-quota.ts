import type { AgentKind } from "@/lib/types"

export type AgentQuotaUnit =
  | "tokens"
  | "requests"
  | "credits"
  | "percent"
  | "seconds"

export type AgentQuotaStatus =
  | "healthy"
  | "warning"
  | "critical"
  | "exhausted"
  | "unavailable"
  | "stale"

export interface AgentQuota {
  agentId: AgentKind
  provider: string
  model: string
  weeklyLimit: number
  weeklyUsed: number
  weeklyRemaining: number
  remainingPercent: number
  unit: AgentQuotaUnit
  resetAt: string
  updatedAt?: string
  status: AgentQuotaStatus
}

const staleAfterMs = 5 * 60 * 1000

export function calculateQuotaState(input: {
  weeklyLimit: number
  weeklyUsed: number
  updatedAt?: string
  now?: number
}): Pick<AgentQuota, "weeklyRemaining" | "remainingPercent" | "status"> {
  const limit = Math.max(0, input.weeklyLimit)
  const used = Math.max(0, input.weeklyUsed)
  const weeklyRemaining = Math.max(0, limit - used)
  const remainingPercent = limit === 0
    ? 0
    : Math.min(100, Math.max(0, (weeklyRemaining / limit) * 100))

  if (
    input.updatedAt &&
    (input.now ?? Date.now()) - Date.parse(input.updatedAt) > staleAfterMs
  ) {
    return { weeklyRemaining, remainingPercent, status: "stale" }
  }

  if (weeklyRemaining === 0) return { weeklyRemaining, remainingPercent, status: "exhausted" }
  if (remainingPercent < 20) return { weeklyRemaining, remainingPercent, status: "critical" }
  if (remainingPercent <= 50) return { weeklyRemaining, remainingPercent, status: "warning" }
  return { weeklyRemaining, remainingPercent, status: "healthy" }
}

export function formatQuotaValue(value: number, unit: AgentQuotaUnit) {
  if (unit === "percent") return `${Math.round(value)}%`

  const formatted = new Intl.NumberFormat("en-US", {
    notation: value >= 10000 ? "compact" : "standard",
    maximumFractionDigits: value >= 10000 ? 1 : 0
  }).format(value)

  return `${formatted} ${unit}`
}
