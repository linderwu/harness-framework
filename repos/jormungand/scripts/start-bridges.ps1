# Start both the codex-bridge and the lucky-mavis-server as detached
# background processes. Mirrors what `start-lucky-mavis-server.ps1` and
# `start-codex-bridge.ps1` do individually, but in a single command so a
# scheduled task or a fresh boot can bring the whole local bridge stack up.
#
# Usage:
#   pwsh scripts/start-bridges.ps1
#
# Each child script picks up env from .env.local; we don't reload it
# here so the per-bridge scripts stay self-contained and runnable on
# their own.

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$luckyScript = Join-Path $scriptDir "start-lucky-mavis-server.ps1"
$codexScript = Join-Path $scriptDir "start-codex-bridge.ps1"

if (-not (Test-Path $luckyScript)) { throw "Missing $luckyScript" }
if (-not (Test-Path $codexScript)) { throw "Missing $codexScript" }

# Lucky first. The codex-bridge forwarder talks to lucky, so lucky
# should be up before codex-bridge starts taking mavis traffic.
Write-Host "=== 1/2 lucky-mavis-server ==="
& $luckyScript
Write-Host ""

Write-Host "=== 2/2 codex-bridge ==="
& $codexScript
Write-Host ""

# Both scripts have their own health checks. The redundant /health probes
# here just print a single summary so the operator can see at a glance
# what's listening.
$summaryHeaders = @{}
if ($env:HARNESS_BRIDGE_TOKEN) { $summaryHeaders["Authorization"] = "Bearer $($env:HARNESS_BRIDGE_TOKEN)" }
elseif ($env:CODEX_BRIDGE_TOKEN) { $summaryHeaders["Authorization"] = "Bearer $($env:CODEX_BRIDGE_TOKEN)" }
elseif ($env:LUCKY_BRIDGE_TOKEN) { $summaryHeaders["Authorization"] = "Bearer $($env:LUCKY_BRIDGE_TOKEN)" }
$lucky = $null
$codex = $null
try { $lucky = Invoke-RestMethod -Uri "http://127.0.0.1:4198/health" -Headers $summaryHeaders -TimeoutSec 3 } catch {}
try { $codex = Invoke-RestMethod -Uri "http://127.0.0.1:4177/health" -Headers $summaryHeaders -TimeoutSec 3 } catch {}

Write-Host "=== summary ==="
if ($lucky) {
  Write-Host "  lucky-mavis-server  : OK    v$($lucky.protocolVersion)  backend=$($lucky.backend)"
} else {
  Write-Host "  lucky-mavis-server  : DOWN  (port 4198)" -ForegroundColor Red
}
if ($codex) {
  Write-Host "  codex-bridge        : OK    v$($codex.protocolVersion)  caps=$($codex.capabilities.Count)"
} else {
  Write-Host "  codex-bridge        : DOWN  (port 4177)" -ForegroundColor Red
}
