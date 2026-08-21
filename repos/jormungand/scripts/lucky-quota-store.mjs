import { promises as fs } from "node:fs"
import path from "node:path"
import os from "node:os"

const WINDOW_SECONDS = Number(
  process.env.LUCKY_QUOTA_WINDOW_SECONDS ?? 5 * 3600
)
const STORE_PATH = resolveStorePath()
const ACTIVE_RUN_TTL_MS = 6 * 60 * 60 * 1000

function resolveStorePath() {
  if (process.env.LUCKY_QUOTA_STORE_PATH) {
    return process.env.LUCKY_QUOTA_STORE_PATH
  }
  const repoRoot =
    process.env.CODEX_BRIDGE_REPO_ROOT ??
    process.env.OPENCLAW_BRIDGE_REPO_ROOT ??
    process.cwd()
  return path.resolve(repoRoot, "data", "lucky-quota.json")
}

function defaultState(nowMs = Date.now()) {
  return {
    windowStartedAt: new Date(nowMs).toISOString(),
    totalUsedSeconds: 0,
    activeRuns: {}
  }
}

async function readState() {
  try {
    const raw = await fs.readFile(STORE_PATH, "utf8")
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === "object" &&
      typeof parsed.totalUsedSeconds === "number"
    ) {
      return {
        windowStartedAt:
          typeof parsed.windowStartedAt === "string"
            ? parsed.windowStartedAt
            : new Date().toISOString(),
        totalUsedSeconds: Math.max(0, parsed.totalUsedSeconds | 0),
        activeRuns:
          parsed.activeRuns && typeof parsed.activeRuns === "object"
            ? parsed.activeRuns
            : {}
      }
    }
  } catch {
    // file missing or unreadable — start fresh
  }
  return defaultState()
}

async function writeState(state) {
  await fs.mkdir(path.dirname(STORE_PATH), { recursive: true })
  const tmp = `${STORE_PATH}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf8")
  await fs.rename(tmp, STORE_PATH)
}

function pruneStaleActiveRuns(state, nowMs) {
  let mutated = false
  for (const [runId, info] of Object.entries(state.activeRuns ?? {})) {
    const startedAt = Number(info?.startedAt ?? 0)
    if (!startedAt || nowMs - startedAt > ACTIVE_RUN_TTL_MS) {
      // treat as finished at startedAt + ttl, count its full window as used
      if (startedAt) {
        const used = Math.max(
          0,
          Math.floor((nowMs - startedAt) / 1000)
        )
        state.totalUsedSeconds += used
      }
      delete state.activeRuns[runId]
      mutated = true
    }
  }
  return mutated
}

export async function getState() {
  const nowMs = Date.now()
  let state = await readState()
  const startMs = state.windowStartedAt
    ? Date.parse(state.windowStartedAt)
    : nowMs
  const endMs = startMs + WINDOW_SECONDS * 1000
  let needsWrite = false

  if (!Number.isFinite(startMs) || nowMs >= endMs) {
    state = defaultState(nowMs)
    needsWrite = true
  }

  if (pruneStaleActiveRuns(state, nowMs)) {
    needsWrite = true
  }

  if (needsWrite) {
    await writeState(state)
  }

  return state
}

export async function startRun(runId, { now = Date.now() } = {}) {
  const state = await getState()
  state.activeRuns[runId] = { startedAt: now }
  await writeState(state)
  return state
}

export async function endRun(runId, { now = Date.now() } = {}) {
  const state = await getState()
  const info = state.activeRuns?.[runId]
  if (info?.startedAt) {
    const duration = Math.max(0, Math.floor((now - info.startedAt) / 1000))
    state.totalUsedSeconds += duration
  }
  if (state.activeRuns) {
    delete state.activeRuns[runId]
  }
  await writeState(state)
  return state
}

export async function readQuota(agentId = "mavis") {
  const state = await getState()
  const remaining = Math.max(0, WINDOW_SECONDS - state.totalUsedSeconds)
  const remainingPercent =
    WINDOW_SECONDS > 0
      ? Math.min(100, Math.max(0, (remaining / WINDOW_SECONDS) * 100))
      : 0

  let status = "healthy"
  if (remaining === 0) status = "exhausted"
  else if (remainingPercent < 20) status = "critical"
  else if (remainingPercent <= 50) status = "warning"

  const startMs = Date.parse(state.windowStartedAt)
  const endMs = startMs + WINDOW_SECONDS * 1000

  return {
    agentId,
    provider: "minimax",
    model: process.env.MINIMAX_BACKEND_MODEL ?? "minimax/MiniMax-M3",
    weeklyLimit: WINDOW_SECONDS,
    weeklyUsed: state.totalUsedSeconds,
    weeklyRemaining: remaining,
    remainingPercent,
    unit: "seconds",
    resetAt: new Date(endMs).toISOString(),
    updatedAt: new Date().toISOString(),
    status
  }
}

export function getStorePath() {
  return STORE_PATH
}

export function getWindowSeconds() {
  return WINDOW_SECONDS
}
