#!/usr/bin/env node
/**
 * bridge-config.mjs — shared device configuration loader for the Jormungand
 * agent bridge runtimes. Loads JSON config from JORMUNGAND_BRIDGE_CONFIG (or
 * the conventional `.harness/bridge.config.json`) and exposes a normalized
 * shape that codex-bridge, openclaw-bridge, minimax-bridge, and the
 * lucky-mavis-server can all share.
 *
 * Configuration shape (see .harness/bridge.config.example.json):
 *
 *   {
 *     "schemaVersion": 1,
 *     "device": {
 *       "id": "device-id",
 *       "name": "Device Name",
 *       "repoRoot": "/abs/path/to/repo",
 *       "permissionMode": "restricted",
 *       "runtimeSkills": {
 *         "enabled": true,
 *         "root": ".harness/runtime-skills",
 *         "cache": ".harness/cache/skills",
 *         "lockfile": ".harness/skill.lock.json"
 *       }
 *     },
 *     "bridge": {
 *       "host": "127.0.0.1",
 *       "port": 4177,
 *       "protocolVersion": "harness-agent-bridge/v0.3",
 *       "completedRunTtlMs": 3600000,
 *       "tokenEnv": "BRIDGE_TOKEN"
 *     },
 *     "runtime": {
 *       "command": "agent-cli",
 *       "model": "approved-model",
 *       "timeoutMs": 900000
 *     }
 *   }
 *
 * Environment variables always win over file values. This lets deployment
 * platforms override per-instance without rewriting the file.
 */

import { readFileSync, existsSync } from "node:fs"
import { resolve } from "node:path"
import process from "node:process"

const DEFAULT_CONFIG_PATHS = [
  process.env.JORMUNGAND_BRIDGE_CONFIG,
  ".harness/bridge.config.json",
  "bridge.config.json"
].filter(Boolean)

export const PROTOCOL_VERSION = "harness-agent-bridge/v0.3"
export const DEFAULT_COMPLETED_RUN_TTL_MS = 30 * 60 * 1000
export const DEFAULT_RUNTIME_TIMEOUT_MS = 900_000
export const DEFAULT_PERMISSION_MODE = "restricted"

let cachedConfig = null

/**
 * Load and normalize the bridge config. Returns null when no config file
 * exists and no environment overrides are present (callers should fall
 * back to env-only mode).
 */
export function loadBridgeConfig(options = {}) {
  if (cachedConfig) return cachedConfig

  const explicitPath = options.path
  const searchPaths = explicitPath
    ? [explicitPath]
    : DEFAULT_CONFIG_PATHS

  let raw = null
  let sourcePath = null
  for (const candidate of searchPaths) {
    const resolved = resolve(candidate)
    if (existsSync(resolved)) {
      try {
        raw = JSON.parse(readFileSync(resolved, "utf8"))
        sourcePath = resolved
        break
      } catch (error) {
        throw new Error(
          `failed to parse bridge config at ${resolved}: ${formatError(error)}`
        )
      }
    }
  }

  const fileDevice = raw?.device ?? {}
  const fileBridge = raw?.bridge ?? {}
  const fileRuntime = raw?.runtime ?? {}
  const fileSkills = fileDevice.runtimeSkills ?? {}

  const config = {
    schemaVersion: raw?.schemaVersion ?? 1,
    sourcePath,
    device: {
      id: process.env.JORMUNGAND_DEVICE_ID ?? fileDevice.id ?? "local-device",
      name: process.env.JORMUNGAND_DEVICE_NAME ?? fileDevice.name ?? "Local device",
      repoRoot: process.env.JORMUNGAND_REPO_ROOT ?? fileDevice.repoRoot ?? process.cwd(),
      permissionMode: normalizePermissionMode(
        process.env.JORMUNGAND_AGENT_PERMISSION_MODE ??
          fileDevice.permissionMode ??
          DEFAULT_PERMISSION_MODE
      ),
      runtimeSkills: {
        enabled: parseBool(
          process.env.JORMUNGAND_RUNTIME_SKILLS_ENABLED ?? fileSkills.enabled,
          false
        ),
        root:
          process.env.JORMUNGAND_RUNTIME_SKILLS_ROOT ??
          fileSkills.root ??
          ".harness/runtime-skills",
        cache:
          process.env.JORMUNGAND_RUNTIME_SKILLS_CACHE ??
          fileSkills.cache ??
          ".harness/cache/skills",
        lockfile:
          process.env.JORMUNGAND_SKILL_LOCKFILE ??
          fileSkills.lockfile ??
          ".harness/skill.lock.json"
      }
    },
    bridge: {
      host:
        process.env.JORMUNGAND_BRIDGE_HOST ??
        fileBridge.host ??
        "127.0.0.1",
      port: Number(
        process.env.JORMUNGAND_BRIDGE_PORT ?? fileBridge.port ?? 0
      ) || fileBridge.port || 0,
      protocolVersion:
        process.env.JORMUNGAND_BRIDGE_PROTOCOL_VERSION ??
        fileBridge.protocolVersion ??
        PROTOCOL_VERSION,
      completedRunTtlMs: Number(
        process.env.JORMUNGAND_BRIDGE_COMPLETED_RUN_TTL_MS ??
          fileBridge.completedRunTtlMs ??
          DEFAULT_COMPLETED_RUN_TTL_MS
      ),
      tokenEnv:
        process.env.JORMUNGAND_BRIDGE_TOKEN_ENV ??
        fileBridge.tokenEnv ??
        "JORMUNGAND_BRIDGE_TOKEN"
    },
    runtime: {
      command:
        process.env.JORMUNGAND_RUNTIME_COMMAND ?? fileRuntime.command ?? null,
      model:
        process.env.JORMUNGAND_RUNTIME_MODEL ?? fileRuntime.model ?? null,
      timeoutMs: Number(
        process.env.JORMUNGAND_RUNTIME_TIMEOUT_MS ??
          fileRuntime.timeoutMs ??
          DEFAULT_RUNTIME_TIMEOUT_MS
      )
    }
  }

  cachedConfig = config
  return config
}

export function resetBridgeConfigCache() {
  cachedConfig = null
}

export function normalizePermissionMode(value) {
  const trimmed = String(value ?? "").trim().toLowerCase()
  if (trimmed === "restricted") return "restricted"
  // Unknown values default to "full" to match the application contract,
  // but only when the operator has explicitly set the env / file. Empty
  // values are passed through as-is and the default is applied by
  // loadBridgeConfig.
  if (trimmed === "full") return "full"
  return trimmed || DEFAULT_PERMISSION_MODE
}

function parseBool(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback
  const v = String(value).trim().toLowerCase()
  if (v === "true" || v === "1" || v === "yes" || v === "on") return true
  if (v === "false" || v === "0" || v === "no" || v === "off") return false
  return fallback
}

function formatError(error) {
  return error instanceof Error ? error.message : String(error)
}

// CLI helper: `node bridge-config.mjs [--path <file>]` prints the resolved
// config as JSON for inspection. Useful for debugging.
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2)
  let path = null
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--path" && i + 1 < args.length) {
      path = args[i + 1]
    }
  }
  const config = loadBridgeConfig({ path })
  process.stdout.write(JSON.stringify(config, null, 2) + "\n")
}
