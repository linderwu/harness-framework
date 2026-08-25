# Start the complete local Pokemon Center runtime:
#   1. lucky-mavis-server (Lucky / MiniMax) on port 4198
#   2. codex-bridge (Codex and mavis forwarder) on port 4177
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-pokemon-center-server.ps1
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-pokemon-center-server.ps1 -SkipPublicVerification
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-pokemon-center-server.ps1 -Restart

[CmdletBinding()]
param(
  [switch]$SkipPublicVerification,
  [switch]$Restart
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$luckyNodeScript = Join-Path $projectRoot "scripts\lucky-mavis-server.mjs"
$codexNodeScript = Join-Path $projectRoot "scripts\codex-bridge.mjs"

if (-not (Test-Path -LiteralPath $luckyNodeScript)) { throw "Cannot find $luckyNodeScript" }
if (-not (Test-Path -LiteralPath $codexNodeScript)) { throw "Cannot find $codexNodeScript" }

function Import-EnvFile([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return }

  Get-Content -LiteralPath $path |
    Where-Object { $_ -and ($_ -notmatch '^\s*#') -and ($_ -match '=') } |
    ForEach-Object {
      $parts = $_ -split '=', 2
      $name = $parts[0].Trim()
      $value = $parts[1].Trim()

      if ($value.StartsWith('"') -and $value.EndsWith('"')) {
        $value = $value.Substring(1, $value.Length - 2)
      } elseif ($value.StartsWith("'") -and $value.EndsWith("'")) {
        $value = $value.Substring(1, $value.Length - 2)
      }

      if (-not $value -or $value -match '^\$\{') { return }
      if (-not (Test-Path "Env:\$name")) {
        Set-Item -Path "Env:\$name" -Value $value
      }
    }
}

Import-EnvFile (Join-Path $projectRoot ".env.local")

if (-not $env:HARNESS_BRIDGE_TOKEN) {
  if ($env:CODEX_BRIDGE_TOKEN) {
    $env:HARNESS_BRIDGE_TOKEN = $env:CODEX_BRIDGE_TOKEN
  } elseif ($env:OPENCLAW_GATEWAY_TOKEN) {
    $env:HARNESS_BRIDGE_TOKEN = $env:OPENCLAW_GATEWAY_TOKEN
  }
}

if (-not $env:LUCKY_BRIDGE_TOKEN -and $env:HARNESS_BRIDGE_TOKEN) {
  $env:LUCKY_BRIDGE_TOKEN = $env:HARNESS_BRIDGE_TOKEN
}

if (-not $env:HARNESS_BRIDGE_TOKEN) {
  throw "Missing CODEX_BRIDGE_TOKEN or HARNESS_BRIDGE_TOKEN"
}

function Get-Health([string]$uri, [string]$token) {
  try {
    $headers = @{ Authorization = "Bearer $token" }
    $result = Invoke-RestMethod -Uri $uri -Headers $headers -TimeoutSec 5
    if ($result.ok -eq $true) { return $result }
  } catch {
    return $null
  }
  return $null
}

function Wait-Health([string]$name, [string]$uri, [string]$token, [int]$timeoutSeconds = 30) {
  $deadline = [DateTime]::UtcNow.AddSeconds($timeoutSeconds)
  do {
    $health = Get-Health $uri $token
    if ($null -ne $health) {
      Write-Host ("{0}: OK  {1}" -f $name, $health.protocolVersion)
      return $health
    }
    Start-Sleep -Seconds 1
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "$name did not become healthy at $uri within ${timeoutSeconds}s"
}

function Start-ManagedService(
  [string]$name,
  [string]$nodeScript,
  [int]$port,
  [string]$healthUri,
  [string]$token,
  [string]$logFile
) {
  $existing = Get-Health $healthUri $token
  if ($null -ne $existing) {
    Write-Host ("{0}: already running" -f $name)
    return $existing
  }

  $occupied = Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
  if ($occupied) {
    throw "$name port $port is occupied by PID $($occupied.OwningProcess), but its health endpoint is unavailable"
  }

  $logDir = Split-Path -Parent $logFile
  if (-not (Test-Path -LiteralPath $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
  }

  Write-Host ("Starting {0}..." -f $name)
  $proc = Start-Process -FilePath "node" -ArgumentList @($nodeScript) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $logFile `
    -RedirectStandardError "$logFile.err" `
    -PassThru
  Write-Host ("{0}: started PID {1}" -f $name, $proc.Id)

  return Wait-Health $name $healthUri $token
}

function Get-ManagedProcessIds([string]$nodeScript) {
  $normalizedScript = [IO.Path]::GetFullPath($nodeScript)
  return @(
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
      Where-Object {
        $_.CommandLine -and $_.CommandLine.Contains($normalizedScript)
      } |
      Select-Object -ExpandProperty ProcessId
  )
}

function Stop-ManagedService(
  [string]$name,
  [string]$nodeScript,
  [int]$port
) {
  $processIds = @(Get-ManagedProcessIds $nodeScript | Sort-Object -Unique)
  $listeners = @(
    Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty OwningProcess
  )
  $unrecognizedListeners = @($listeners | Where-Object { $_ -notin $processIds -and $_ -ne 0 })

  if ($unrecognizedListeners.Count -gt 0) {
    throw "$name port $port is occupied by unrecognized PID(s): $($unrecognizedListeners -join ', ')"
  }

  if ($processIds.Count -eq 0) {
    Write-Host ("{0}: not running" -f $name)
    return
  }

  foreach ($processId in $processIds) {
    Write-Host ("Stopping {0} PID {1}..." -f $name, $processId)
    Stop-Process -Id $processId -Force -ErrorAction Stop
  }

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  do {
    $remainingProcesses = @(Get-ManagedProcessIds $nodeScript)
    $remainingListeners = @(
      Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue
    )
    if ($remainingProcesses.Count -eq 0 -and $remainingListeners.Count -eq 0) {
      Write-Host ("{0}: stopped" -f $name)
      return
    }
    Start-Sleep -Milliseconds 250
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "$name did not stop cleanly on port $port"
}

Write-Host "=== Pokemon Center Server ==="
Write-Host ("Repo: {0}" -f $projectRoot.Path)
Write-Host ""

if ($Restart) {
  Write-Host "Restart requested."
  Stop-ManagedService "Codex Bridge" $codexNodeScript 4177
  Stop-ManagedService "Lucky / MiniMax" $luckyNodeScript 4198
  Write-Host ""
}

# Lucky must be ready before Codex starts accepting mavis forwarding traffic.
$luckyHealth = Start-ManagedService `
  "Lucky / MiniMax" `
  $luckyNodeScript `
  4198 `
  "http://127.0.0.1:4198/health" `
  $env:LUCKY_BRIDGE_TOKEN `
  (Join-Path $projectRoot "logs\lucky-mavis-server.log")

$codexHealth = Start-ManagedService `
  "Codex Bridge" `
  $codexNodeScript `
  4177 `
  "http://127.0.0.1:4177/health" `
  $env:HARNESS_BRIDGE_TOKEN `
  (Join-Path $projectRoot "logs\codex-bridge.log")

Write-Host ""
Write-Host "=== Local summary ==="
Write-Host ("  Lucky / MiniMax: OK  backend={0}" -f $luckyHealth.backend)
Write-Host ("  Codex Bridge:   OK  capabilities={0}" -f $codexHealth.capabilities.Count)

if (-not $SkipPublicVerification) {
  if (-not $env:CODEX_BRIDGE_URL) {
    throw "CODEX_BRIDGE_URL is required for public verification"
  }

  $publicHealthUri = $env:CODEX_BRIDGE_URL.TrimEnd('/') + "/health"
  $publicHealth = Wait-Health "Public Codex Bridge" $publicHealthUri $env:HARNESS_BRIDGE_TOKEN
  Write-Host ("  Public Codex:   OK  protocol={0}" -f $publicHealth.protocolVersion)
}

Write-Host ""
Write-Host "Pokemon Center Server is online."
