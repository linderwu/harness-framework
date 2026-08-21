# Start the lucky-mavis-server as a detached background process.
# This is the bridge that powers the Lucky (mavis) agent card on the
# Jormungand dashboard. Unlike the codex-bridge, this server gives Lucky
# local file-system and shell tools via the MiniMax-M3 function-calling
# loop, so a Lucky run can actually read, edit, and run code in the
# operator-approved workspace.
#
# Usage:
#   pwsh scripts/start-lucky-mavis-server.ps1
#
# Required env:
#   LUCKY_BRIDGE_TOKEN (or HARNESS_BRIDGE_TOKEN / CODEX_BRIDGE_TOKEN)
#   LUCKY_BACKEND_URL   — the MiniMax chat completions endpoint
#                         (e.g. https://api.minimax.io/v1)
#   LUCKY_BACKEND_TOKEN — the MiniMax API key
#
# Optional env:
#   LUCKY_BRIDGE_HOST         (default 127.0.0.1)
#   LUCKY_BRIDGE_PORT         (default 4198)
#   LUCKY_BRIDGE_REPO_ROOT    (default: CODEX_BRIDGE_REPO_ROOT or cwd)
#   LUCKY_BACKEND_MODEL       (default MiniMax-M3)
#   LUCKY_BACKEND_TIMEOUT_MS  (default 600000)
#   LUCKY_TOOL_ITERATION_CAP  (default 25)
#   LUCKY_QUOTA_STORE_PATH    (default: <repo>/data/lucky-quota.json)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$nodeScript = Join-Path $projectRoot "scripts\lucky-mavis-server.mjs"

if (-not (Test-Path $nodeScript)) {
  throw "Cannot find $nodeScript"
}

# Best-effort: load .env.local from the project root so the bridge picks up
# LUCKY_BRIDGE_URL / LUCKY_BRIDGE_TOKEN / LUCKY_BACKEND_* without needing
# them to live in the user-level registry. Existing process env wins.
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
      if (-not (Test-Path "Env:\$name")) { Set-Item -Path "Env:\$name" -Value $value }
    }
}

$host_ = $env:LUCKY_BRIDGE_HOST
if (-not $host_) { $host_ = "127.0.0.1" }

$port_ = $env:LUCKY_BRIDGE_PORT
if (-not $port_) { $port_ = "4198" }

if (-not $env:LUCKY_BRIDGE_TOKEN) {
  if ($env:HARNESS_BRIDGE_TOKEN) { $env:LUCKY_BRIDGE_TOKEN = $env:HARNESS_BRIDGE_TOKEN }
  elseif ($env:CODEX_BRIDGE_TOKEN) { $env:LUCKY_BRIDGE_TOKEN = $env:CODEX_BRIDGE_TOKEN }
}

if (-not $env:LUCKY_BACKEND_URL) {
  if ($env:MINIMAX_BACKEND_URL) { $env:LUCKY_BACKEND_URL = $env:MINIMAX_BACKEND_URL }
  else { $env:LUCKY_BACKEND_URL = "https://api.minimax.io/v1" }
}

if (-not $env:LUCKY_BACKEND_MODEL) {
  $env:LUCKY_BACKEND_MODEL = "MiniMax-M3"
}

if (-not $env:LUCKY_BACKEND_TOKEN) {
  if ($env:MINIMAX_BACKEND_TOKEN) { $env:LUCKY_BACKEND_TOKEN = $env:MINIMAX_BACKEND_TOKEN }
}

if (-not $env:LUCKY_BRIDGE_REPO_ROOT) {
  if ($env:CODEX_BRIDGE_REPO_ROOT) { $env:LUCKY_BRIDGE_REPO_ROOT = $env:CODEX_BRIDGE_REPO_ROOT }
  else { $env:LUCKY_BRIDGE_REPO_ROOT = $projectRoot.Path }
}

if (-not $env:LUCKY_QUOTA_STORE_PATH) {
  if ($env:CODEX_BRIDGE_REPO_ROOT) {
    $env:LUCKY_QUOTA_STORE_PATH = Join-Path $env:CODEX_BRIDGE_REPO_ROOT "data\lucky-quota.json"
  } else {
    $env:LUCKY_QUOTA_STORE_PATH = Join-Path $projectRoot.Path "data\lucky-quota.json"
  }
}

$logDir = Join-Path $projectRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "lucky-mavis-server.log"

Write-Host "Starting lucky-mavis-server detached:"
Write-Host "  bind:        http://${host_}:${port_}"
Write-Host "  token:       $(if ($env:LUCKY_BRIDGE_TOKEN) { 'set' } else { 'loopback-only' })"
Write-Host "  backend:     $($env:LUCKY_BACKEND_URL)"
Write-Host "  model:       $($env:LUCKY_BACKEND_MODEL)"
Write-Host "  repo root:   $($env:LUCKY_BRIDGE_REPO_ROOT)"
Write-Host "  quota store: $($env:LUCKY_QUOTA_STORE_PATH)"
Write-Host "  logfile:     $logFile"

$proc = Start-Process -FilePath "node" -ArgumentList $nodeScript `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError "$logFile.err" `
  -PassThru

Write-Host "Started PID $($proc.Id). Bridge is detached and survives session exit."

Start-Sleep -Seconds 1
$check = Invoke-RestMethod -Uri "http://${host_}:${port_}/health" -TimeoutSec 5
Write-Host "Health check: ok=$($check.ok) protocolVersion=$($check.protocolVersion) backend=$($check.backend)"
