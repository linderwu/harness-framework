# Monitor Codex Bridge and Lucky/MiniMax memory without changing service state.
#
# Usage:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\monitor-pokemon-center-memory.ps1

[CmdletBinding()]
param(
  [int]$IntervalSeconds = 60,
  [int]$AlertThresholdMB = 512
)

$ErrorActionPreference = "Stop"
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = Resolve-Path (Join-Path $scriptDir "..")
$logDir = Join-Path $projectRoot "logs"
$logFile = Join-Path $logDir "pokemon-center-memory.log"

if (-not (Test-Path -LiteralPath $logDir)) {
  New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$services = @{
  4177 = "codex-bridge"
  4198 = "lucky-mavis-server"
}

function Get-ServiceMemory([int]$port) {
  $listener = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -First 1

  if (-not $listener) {
    return [pscustomobject]@{
      Timestamp = (Get-Date).ToString("o")
      Service = $services[$port]
      Port = $port
      PID = ""
      WorkingSetMB = ""
      PrivateMB = ""
      Status = "OFFLINE"
    }
  }

  $process = Get-Process -Id $listener.OwningProcess -ErrorAction SilentlyContinue
  if (-not $process) {
    return [pscustomobject]@{
      Timestamp = (Get-Date).ToString("o")
      Service = $services[$port]
      Port = $port
      PID = $listener.OwningProcess
      WorkingSetMB = ""
      PrivateMB = ""
      Status = "PROCESS_GONE"
    }
  }

  $workingSetMB = [math]::Round($process.WorkingSet64 / 1MB, 1)
  $privateMB = [math]::Round($process.PrivateMemorySize64 / 1MB, 1)
  $status = if ($workingSetMB -ge $AlertThresholdMB -or $privateMB -ge $AlertThresholdMB) {
    "ALERT_MEMORY"
  } else {
    "OK"
  }

  return [pscustomobject]@{
    Timestamp = (Get-Date).ToString("o")
    Service = $services[$port]
    Port = $port
    PID = $process.Id
    WorkingSetMB = $workingSetMB
    PrivateMB = $privateMB
    Status = $status
  }
}

while ($true) {
  foreach ($port in $services.Keys | Sort-Object) {
    $row = Get-ServiceMemory $port
    $line = $row | ConvertTo-Csv -NoTypeInformation | Select-Object -Last 1
    Add-Content -LiteralPath $logFile -Value $line
    Write-Output ($row | ConvertTo-Json -Compress)
  }

  Start-Sleep -Seconds ([math]::Max(5, $IntervalSeconds))
}
