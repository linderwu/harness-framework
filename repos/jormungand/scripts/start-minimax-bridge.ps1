# Start the minimax-bridge as a detached background process.
# Survives the parent PowerShell session exiting (no 30-minute tool-timeout).
#
# Usage:
#   pwsh scripts/start-minimax-bridge.ps1
# Optional env overrides:
#   MINIMAX_BRIDGE_HOST (default 127.0.0.1)
#   MINIMAX_BRIDGE_PORT (default 4199)
#   MINIMAX_BRIDGE_TOKEN (optional bearer token; omit for loopback-only)
#   MINIMAX_BACKEND_URL or MINIMAX_BACKEND_COMMAND (optional real backend)
#   HARNESS_BRIDGE_TOKEN (alternative token source)
#   MINIMAX_GATEWAY_TOKEN (alternative token source)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$nodeScript = Join-Path $projectRoot "scripts\minimax-bridge.mjs"

if (-not (Test-Path $nodeScript)) {
  throw "Cannot find $nodeScript"
}

$host_ = $env:MINIMAX_BRIDGE_HOST
if (-not $host_) { $host_ = "127.0.0.1" }

$port_ = $env:MINIMAX_BRIDGE_PORT
if (-not $port_) { $port_ = "4199" }

$token = $env:MINIMAX_BRIDGE_TOKEN
if (-not $token) { $token = $env:HARNESS_BRIDGE_TOKEN }
if (-not $token) { $token = $env:MINIMAX_GATEWAY_TOKEN }

$logDir = Join-Path $projectRoot "logs"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir "minimax-bridge.log"

$env:MINIMAX_BRIDGE_HOST = $host_
$env:MINIMAX_BRIDGE_PORT = $port_
if ($token) { $env:MINIMAX_BRIDGE_TOKEN = $token } else { Remove-Item Env:MINIMAX_BRIDGE_TOKEN -ErrorAction SilentlyContinue }

Write-Host "Starting minimax-bridge detached:"
Write-Host "  bind:     http://${host_}:${port_}"
Write-Host "  token:    $(if ($token) { 'set' } else { 'loopback-only' })"
Write-Host "  backend:  $(if ($env:MINIMAX_BACKEND_URL) { $env:MINIMAX_BACKEND_URL } elseif ($env:MINIMAX_BACKEND_COMMAND) { $env:MINIMAX_BACKEND_COMMAND } else { 'echo (no backend configured)' })"
Write-Host "  logfile:  $logFile"

$proc = Start-Process -FilePath "node" -ArgumentList $nodeScript `
  -WorkingDirectory $projectRoot `
  -WindowStyle Hidden `
  -RedirectStandardOutput $logFile `
  -RedirectStandardError "$logFile.err" `
  -PassThru

Write-Host "Started PID $($proc.Id). Bridge is detached and survives session exit."

Start-Sleep -Seconds 1
$check = Invoke-RestMethod -Uri "http://${host_}:${port_}/health" -TimeoutSec 5
Write-Host "Health check: ok=$($check.ok) protocolVersion=$($check.protocolVersion)"
