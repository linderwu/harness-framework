import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

export function loadBridgeConfig(options = {}) {
  const configuredPath = options.path ?? process.env.BRIDGE_CONFIG_PATH ?? path.join(".harness", "bridge.config.json")
  const configPath = path.isAbsolute(String(configuredPath))
    ? path.resolve(String(configuredPath))
    : path.resolve(projectRoot, String(configuredPath))
  const raw = existsSync(configPath)
    ? JSON.parse(readFileSync(configPath, "utf8"))
    : {}
  const config = normalizeBridgeConfig(raw)

  applyBridgeConfigEnvironment(config)
  return { ...config, configPath }
}

export function normalizeBridgeConfig(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Bridge config must be a JSON object.")
  }

  if (input.bridges && !input.device) {
    return normalizeBridgeConfig(normalizeLegacyConfig(input))
  }

  const device = input.device ?? {}
  const bridge = input.bridge ?? {}
  const runtimes = input.runtimes ?? {}
  const codex = runtimes.codex ?? {}
  const lucky = runtimes.lucky ?? {}
  const luckyBackend = lucky.backend ?? {}
  const runtimeSkills = device.runtimeSkills ?? {}
  const repoRoot = resolveFromProjectRoot(
    device.repoRoot ?? process.env.CODEX_BRIDGE_REPO_ROOT ?? projectRoot
  )
  const luckyHost = String(lucky.host ?? "127.0.0.1")
  const luckyPort = positiveInteger(lucky.port, 4198)

  return {
    schemaVersion: 1,
    device: {
      id: String(device.id ?? "codex-bridge-device"),
      name: String(device.name ?? "Local Codex Bridge Device"),
      repoRoot,
      permissionMode: normalizePermissionMode(
        device.permissionMode ?? process.env.JORMUNGAND_AGENT_PERMISSION_MODE
      ),
      runtimeSkills: {
        enabled: toBoolean(
          runtimeSkills.enabled ?? process.env.CODEX_BRIDGE_RUNTIME_SKILLS === "1",
          true
        ),
        root: resolveFromRepoRoot(runtimeSkills.root ?? ".harness/runtime-skills", repoRoot),
        cache: resolveFromRepoRoot(runtimeSkills.cache ?? ".harness/cache/skills", repoRoot)
      }
    },
    bridge: {
      host: String(bridge.host ?? "127.0.0.1"),
      port: positiveInteger(bridge.port, 4177),
      protocolVersion: String(bridge.protocolVersion ?? "harness-agent-bridge/v0.3"),
      completedRunTtlMs: positiveInteger(bridge.completedRunTtlMs, 3_600_000),
      tokenEnv: String(bridge.tokenEnv ?? "HARNESS_BRIDGE_TOKEN")
    },
    runtimes: {
      codex: {
        enabled: toBoolean(codex.enabled, true),
        command: String(codex.command ?? "codex"),
        serviceTier: String(codex.serviceTier ?? "fast"),
        sandbox: String(codex.sandbox ?? "workspace-write"),
        timeoutMs: positiveInteger(codex.timeoutMs, 900_000),
        sessionRequestTimeoutMs: positiveInteger(codex.sessionRequestTimeoutMs, 120_000)
      },
      lucky: {
        enabled: toBoolean(lucky.enabled, true),
        host: luckyHost,
        port: luckyPort,
        tokenEnv: String(lucky.tokenEnv ?? "LUCKY_BRIDGE_TOKEN"),
        backend: {
          url: String(luckyBackend.url ?? "https://api.minimax.io/v1"),
          model: String(luckyBackend.model ?? "MiniMax-M3"),
          tokenEnv: String(luckyBackend.tokenEnv ?? "LUCKY_BACKEND_TOKEN"),
          timeoutMs: positiveInteger(luckyBackend.timeoutMs, 600_000)
        },
        limits: {
          toolIterationCap: positiveInteger(lucky.limits?.toolIterationCap, 25),
          toolCallTimeoutMs: positiveInteger(lucky.limits?.toolCallTimeoutMs, 120_000),
          runCommandTimeoutMs: positiveInteger(lucky.limits?.runCommandTimeoutMs, 300_000),
          maxReadBytes: positiveInteger(lucky.limits?.maxReadBytes, 512_000),
          maxOutputBytes: positiveInteger(lucky.limits?.maxOutputBytes, 256_000)
        },
        quotaStorePath: resolveFromRepoRoot(lucky.quotaStorePath ?? "data/lucky-quota.json", repoRoot)
      }
    },
    routing: {
      defaultRuntime: String(input.routing?.defaultRuntime ?? "codex"),
      luckyBridgeUrl: String(input.routing?.luckyBridgeUrl ?? `http://${luckyHost}:${luckyPort}`)
    },
    secrets: {
      bridgeTokenEnv: String(input.secrets?.bridgeTokenEnv ?? bridge.tokenEnv ?? "HARNESS_BRIDGE_TOKEN"),
      codexClientTokenEnv: String(input.secrets?.codexClientTokenEnv ?? "CODEX_BRIDGE_TOKEN"),
      luckyBridgeTokenEnv: String(input.secrets?.luckyBridgeTokenEnv ?? lucky.tokenEnv ?? "LUCKY_BRIDGE_TOKEN"),
      luckyBackendTokenEnv: String(input.secrets?.luckyBackendTokenEnv ?? luckyBackend.tokenEnv ?? "LUCKY_BACKEND_TOKEN")
    }
  }
}

function normalizeLegacyConfig(input) {
  const codex = input.bridges?.codex ?? {}
  const lucky = input.bridges?.lucky ?? {}
  const legacyRouting = input.routing ?? {}

  return {
    schemaVersion: 1,
    device: {
      id: "codex-bridge-device",
      name: "Local Codex Bridge Device",
      repoRoot: codex.repoRoot ?? lucky.repoRoot,
      runtimeSkills: { enabled: codex.runtimeSkills ?? true }
    },
    bridge: {
      host: codex.host,
      port: codex.port,
      protocolVersion: codex.runtimeSkills ? "harness-agent-bridge/v0.3" : "harness-agent-bridge/v0.2",
      tokenEnv: "HARNESS_BRIDGE_TOKEN"
    },
    runtimes: {
      codex: {},
      lucky: {
        host: lucky.host,
        port: lucky.port,
        backend: { url: lucky.backend?.url, model: lucky.backend?.model },
        quotaStorePath: lucky.quotaStorePath
      }
    },
    routing: {
      defaultRuntime: "codex",
      luckyBridgeUrl: legacyRouting.lucky ?? `http://${lucky.host ?? "127.0.0.1"}:${lucky.port ?? 4198}`
    },
    secrets: {
      bridgeTokenEnv: "HARNESS_BRIDGE_TOKEN",
      codexClientTokenEnv: "CODEX_BRIDGE_TOKEN",
      luckyBridgeTokenEnv: "LUCKY_BRIDGE_TOKEN",
      luckyBackendTokenEnv: "LUCKY_BACKEND_TOKEN"
    }
  }
}

function applyBridgeConfigEnvironment(config) {
  const runtimeSkills = config.device.runtimeSkills
  const codex = config.runtimes.codex
  const lucky = config.runtimes.lucky

  setEnv("CODEX_BRIDGE_HOST", config.bridge.host)
  setEnv("CODEX_BRIDGE_PORT", config.bridge.port)
  setEnv("CODEX_BRIDGE_REPO_ROOT", config.device.repoRoot)
  setEnv("CODEX_BRIDGE_RUNTIME_SKILL_ROOT", runtimeSkills.root)
  setEnv("CODEX_BRIDGE_RUNTIME_SKILL_CACHE", runtimeSkills.cache)
  setEnv("CODEX_BRIDGE_RUNTIME_SKILLS", runtimeSkills.enabled ? "1" : "0")
  setEnv("CODEX_BRIDGE_COMPLETED_RUN_TTL_MS", config.bridge.completedRunTtlMs)
  setEnv("JORMUNGAND_AGENT_PERMISSION_MODE", config.device.permissionMode)
  setEnv("CODEX_BRIDGE_COMMAND", codex.command)
  setEnv("CODEX_BRIDGE_SERVICE_TIER", codex.serviceTier)
  setEnv("CODEX_BRIDGE_SANDBOX", codex.sandbox)
  setEnv("CODEX_BRIDGE_TIMEOUT_MS", codex.timeoutMs)
  setEnv("CODEX_BRIDGE_SESSION_REQUEST_TIMEOUT_MS", codex.sessionRequestTimeoutMs)
  setEnv("CODEX_BRIDGE_PROTOCOL_VERSION", config.bridge.protocolVersion)
  setEnv("LUCKY_BRIDGE_URL", config.routing.luckyBridgeUrl)
  setEnv("LUCKY_BRIDGE_HOST", lucky.host)
  setEnv("LUCKY_BRIDGE_PORT", lucky.port)
  setEnv("LUCKY_BRIDGE_REPO_ROOT", config.device.repoRoot)
  setEnv("LUCKY_BACKEND_URL", lucky.backend.url)
  setEnv("LUCKY_BACKEND_MODEL", lucky.backend.model)
  setEnv("LUCKY_BACKEND_TIMEOUT_MS", lucky.backend.timeoutMs)
  setEnv("LUCKY_TOOL_ITERATION_CAP", lucky.limits.toolIterationCap)
  setEnv("LUCKY_TOOL_CALL_TIMEOUT_MS", lucky.limits.toolCallTimeoutMs)
  setEnv("LUCKY_RUN_COMMAND_TIMEOUT_MS", lucky.limits.runCommandTimeoutMs)
  setEnv("LUCKY_MAX_READ_BYTES", lucky.limits.maxReadBytes)
  setEnv("LUCKY_MAX_OUTPUT_BYTES", lucky.limits.maxOutputBytes)
  setEnv("LUCKY_QUOTA_STORE_PATH", lucky.quotaStorePath)
}

function setEnv(name, value) {
  if (process.env[name]?.trim()) return
  process.env[name] = String(value)
}

function resolveFromProjectRoot(value) {
  return path.resolve(projectRoot, String(value))
}

function resolveFromRepoRoot(value, repoRoot) {
  return path.isAbsolute(String(value)) ? path.resolve(String(value)) : path.resolve(repoRoot, String(value))
}

function normalizePermissionMode(value) {
  return String(value ?? "").trim().toLowerCase() === "restricted" ? "restricted" : "full"
}

function positiveInteger(value, fallback) {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : fallback
}

function toBoolean(value, fallback) {
  if (value === undefined) return fallback
  if (typeof value === "boolean") return value
  return String(value).trim().toLowerCase() === "true" || value === 1 || value === "1"
}
