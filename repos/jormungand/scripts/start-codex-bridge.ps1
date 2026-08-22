# Start the codex-bridge as a detached background process.
# This is the local bridge that powers the Codex (Arceus) agent card on the
# Jormungand dashboard. After commit 4fb2055 + 5bc26c1 it also reverse-proxies
# mavis (Lucky) calls and the mavis quota probe to the local
# lucky-mavis-server (port 4198), so the dashboard can use a single public
# endpoint for every agent.
#
# Usage:
#   pwsh scripts/start-codex-bridge.ps1
#
# Required env:
#   HARNESS_BRIDGE_TOKEN (or CODEX_BRIDGE_TOKEN / OPENCLAW_GATEWAY_TOKEN)
#   CODEX_BRIDGE_REPO_ROOT    (default: cwd)
#   LUCKY_BRIDGE_URL         (default http://127.0.0.1:4198) — the mavis
#                              forwarder target. Set this even if you don't
#                              use Lucky so the forwarder can fail fast
#                              instead of silently pointing at 127.0.0.1.
#
# Optional env:
#   CODEX_BRIDGE_HOST         (default 127.0.0.1)
#   CODEX_BRIDGE_PORT         (default 4177)
#   CODEX_BRIDGE_RUNTIME_SKILLS (default off; set to 1 to accept v0.3 with
#                              runtime skill bundles — needed when the
#                              dashboard sends v0.3 for mavis calls that
#                              have non-empty runtimeSkillBundles)
#   JORMUNGAND_AGENT_PERMISSION_MODE (default unset)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$nodeScript = Join-Path $projectRoot "scripts\codex-bridge.mjs"

if (-not (Test-Path $nodeScript)) {
  throw "Cannot find $nodeScript"
}

# Best-effort: load .env.local from the project root so the bridge picks up
# HARNESS_BRIDGE_TOKEN / CODEX_BRIDGE_REPO_ROOT / LUCKY_BRIDGE_URL / etc.
# without needing them to live in the user-level registry. Existing process
# env wins. .env.local at the root holds CODEX_BRIDGE_RUNTIME_SKILLS=1 so the
# forwarder accepts v0.3 mavis payloads.
$envLocalPath = Join-Path $projectRoot ".env.local"
if (Test-Path $envLocalPath) {
  Get-Content $envLocalPath |
    Where-Object { $_ -and ($_ -notmatch '^\s*#') -and ($_ -match '=') } |
    ForEach-Object {
      $parts = $_ -split '=', 2
      $name = $parts[0].Trim()
      $value = $parts[1].Trim()
      # strip surrounding quotes
      if ($value.StartsWith('"') -and $value.EndsWith('"')) {
        $value = $value.Substring(1, $value.Length - 2)
      } elseif ($value.StartsWith("'") -and $value.EndsWith("'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      # skip empty values and ${WEB_PORT} placeholders
      if (-not $value) { return }
      if ($value -match '^\$\{') { return }
      if (-not (Test-Path "Env:\$name")) {
        Set-Item -Path "Env:\$name" -Value $value
      }
    }
}

$host_ = $env:CODEX_BRIDGE_HOST
if (-not $host_) { $host_ = "127.0.0.1" }

$port_ = $env:CODEX_BRIDGE_PORT
if (-not $port_) { $port_ = "4177" }

if (-not $env:HARNESS_BRIDGE_TOKEN) {
  if ($env:CODEX_BRIDGE_TOKEN) { $env:HARNESS_BRIDGE_TOKEN = $env:CODEX_BRIDGE_TOKEN }
  elseif ($env:OPENCLAW_GATEWAY_TOKEN) { $env:HARNESS_BRIDGE_TOKEN = $env:OPENCLAW_GATEWAY_TOKEN }
}

if (-not $env:CODEX_BRIDGE_REPO_ROOT) {
  $env:CODEX_BRIDGE_REPO_ROOT = $projectRoot.Path
}

if (-not $env:LUCKY_BRIDGE_URL) {
  $env:LUCKY_BRIDGE_URL = "http://127.0.0.1:4198"
}

if (-not (Test-Path "Env:CODEX_BRIDGE_RUNTIME_SKILLS")) {
  # Default to v0.3 so the mavis forwarder accepts the v0.3 callers from
  # the dashboard (v0.2 still works because lucky-mavis-server now accepts
  # both). Operators who only dispatch codex can set this to 0 explicitly.
  $env:CODEX_BRIDGE_RUNTIME_SKILLS = "1"
}

$logDir = Join-Path $projectRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "codex-bridge.log"

Write-Host "Starting codex-bridge detached:"
Write-Host "  bind:                http://${host_}:${port_}"
Write-Host "  token:               $(if ($env:HARNESS_BRIDGE_TOKEN) { 'set' } else { 'loopback-only' })"
Write-Host "  repo root:           $($env:CODEX_BRIDGE_REPO_ROOT)"
Write-Host "  mavis forwarder:     $($env:LUCKY_BRIDGE_URL)"
Write-Host "  runtime skills v0.3: $($env:CODEX_BRIDGE_RUNTIME_SKILLS)"
Write-Host "  logfile:             $logFile"

# If something is already on the port, fail loudly so the operator doesn't
# end up with two bridges racing for the same tunnel.
$existing = Get-NetTCPConnection -State Listen -LocalPort $port_ -ErrorAction SilentlyContinue
if ($existing) {
  $existingPid = $existing.OwningProcess
  Write-Host "Port ${port_} is already in use by PID $existingPid." -ForegroundColor Yellow
  Write-Host "If that is the codex-bridge you want, leave it. Otherwise stop it first." -ForegroundColor Yellow
  throw "codex-bridge port already in use"
}

$proc = Start-Process -FilePath "node" -ArgumentList $nodeScript `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError "$logFile.err" `
  -PassThru

Write-Host "Started PID $($proc.Id). Bridge is detached and survives session exit."

Start-Sleep -Seconds 1
$tokenHeader = if ($env:HARNESS_BRIDGE_TOKEN) { @{ Authorization = "Bearer $($env:HARNESS_BRIDGE_TOKEN)" } } else { @{} }
$check = Invoke-RestMethod -Uri "http://${host_}:${port_}/health" -Headers $tokenHeader -TimeoutSec 5
Write-Host "Health check: ok=$($check.ok) protocolVersion=$($check.protocolVersion) capabilities=$($check.capabilities -join ',')"
