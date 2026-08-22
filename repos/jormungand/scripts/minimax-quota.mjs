const QUOTA_PATH = "/token_plan/remains"
const DEFAULT_MODEL = "minimax/MiniMax-M3"

function clampPercent(value) {
  return Math.min(100, Math.max(0, value))
}

function parseEpoch(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 1e12 ? value * 1000 : value
    return Number.isFinite(milliseconds) ? milliseconds : undefined
  }

  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value)
    if (Number.isFinite(numeric)) return parseEpoch(numeric)
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  return undefined
}

function selectChatRow(payload) {
  const rows = Array.isArray(payload?.model_remains)
    ? payload.model_remains.filter(
        (row) => row && typeof row === "object"
      )
    : []

  return (
    rows.find((row) => {
      const name = String(row.model_name ?? "").toLowerCase()
      return name === "general" || name.includes("m3") || name.includes("m2.7")
    }) ??
    rows.find((row) => Number.isFinite(Number(row.current_interval_remaining_percent)))
  )
}

function getStatus(remainingPercent) {
  if (remainingPercent === 0) return "exhausted"
  if (remainingPercent < 20) return "critical"
  if (remainingPercent <= 50) return "warning"
  return "healthy"
}

function unavailableQuota({ agentId, model, now = Date.now() } = {}) {
  const updatedAt = new Date(now).toISOString()
  return {
    agentId: agentId ?? "mavis",
    provider: "minimax",
    model: model ?? DEFAULT_MODEL,
    weeklyLimit: 100,
    weeklyUsed: 0,
    weeklyRemaining: 0,
    remainingPercent: 0,
    unit: "percent",
    resetAt: updatedAt,
    updatedAt,
    status: "unavailable"
  }
}

export function parseMiniMaxQuotaResponse(payload, options = {}) {
  const row = selectChatRow(payload)
  const rawRemainingPercent = Number(row?.current_interval_remaining_percent)

  if (!Number.isFinite(rawRemainingPercent)) {
    return unavailableQuota(options)
  }

  const remainingPercent = clampPercent(rawRemainingPercent)
  const now = options.now ?? Date.now()
  const endMs = parseEpoch(row.end_time ?? row.endTime)
  const updatedAt = new Date(now).toISOString()

  return {
    agentId: options.agentId ?? "mavis",
    provider: "minimax",
    model: String(row.model_name ?? options.model ?? DEFAULT_MODEL),
    weeklyLimit: 100,
    weeklyUsed: 100 - remainingPercent,
    weeklyRemaining: remainingPercent,
    remainingPercent,
    unit: "percent",
    resetAt: new Date(endMs ?? now).toISOString(),
    updatedAt,
    status: getStatus(remainingPercent)
  }
}

export function buildMiniMaxQuotaUrl(baseUrl) {
  const normalized = String(baseUrl ?? "")
    .trim()
    .replace(/\/+$/, "")
    .replace(/\/chat\/completions$/, "")

  if (!normalized) throw new Error("MiniMax quota base URL is not configured")
  if (normalized.endsWith("/v1")) return `${normalized}${QUOTA_PATH}`
  return `${normalized}/v1${QUOTA_PATH}`
}

export async function fetchMiniMaxQuota({
  baseUrl,
  token,
  agentId = "mavis",
  model = DEFAULT_MODEL,
  fetchImpl = globalThis.fetch,
  timeoutMs = 15_000
} = {}) {
  if (!token || typeof fetchImpl !== "function") {
    return unavailableQuota({ agentId, model })
  }

  try {
    const response = await fetchImpl(buildMiniMaxQuotaUrl(baseUrl), {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json"
      },
      signal: AbortSignal.timeout(timeoutMs)
    })
    const payload = await response.json()

    if (!response.ok || payload?.base_resp?.status_code > 0) {
      return unavailableQuota({ agentId, model })
    }

    return parseMiniMaxQuotaResponse(payload, { agentId, model })
  } catch {
    return unavailableQuota({ agentId, model })
  }
}
