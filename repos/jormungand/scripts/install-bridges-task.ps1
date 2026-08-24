# Install a Windows Scheduled Task that brings the local bridge stack
# (codex-bridge + lucky-mavis-server) up automatically at user logon.
# Run this once after a clean machine setup.
#
# Usage (elevated PowerShell):
#   pwsh scripts/install-bridges-task.ps1
#
# What it does:
#   - Registers a task named "jormungand-bridges" under the current user
#   - Trigger: AtLogOn (fires once the user signs in)
#   - Action: pwsh.exe with the absolute path to start-bridges.ps1
#   - Runs in the current user's session, with the user's credentials, so
#     the spawned Node processes inherit user-level env (PATH, etc.) and
#     can read .env.local from the project tree.
#
# To remove the task later:
#   Unregister-ScheduledTask -TaskName "jormungand-bridges" -Confirm:$false

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgesScript = Join-Path $scriptDir "start-bridges.ps1"

if (-not (Test-Path $bridgesScript)) {
  throw "Missing $bridgesScript"
}

$taskName = "jormungand-bridges"
$pwsh = (Get-Command pwsh.exe -ErrorAction Stop).Source

$action = New-ScheduledTaskAction `
  -Execute $pwsh `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$bridgesScript`"" `
  -WorkingDirectory (Split-Path -Parent $scriptDir)

$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

$settings = New-ScheduledTaskSettingsSet `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -StartWhenAvailable `
  -ExecutionTimeLimit (New-TimeSpan -Hours 1)

$principal = New-ScheduledTaskPrincipal `
  -UserId $env:USERNAME `
  -LogonType Interactive `
  -RunLevel Limited

# Replace any existing task with the same name.
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
  Write-Host "Removing existing task '$taskName'"
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
}

Write-Host "Registering scheduled task '$taskName' (user=$env:USERNAME, trigger=AtLogOn)"
Register-ScheduledTask `
  -TaskName $taskName `
  -Action $action `
  -Trigger $trigger `
  -Settings $settings `
  -Principal $principal `
  -Description "Bring the local Jormungand bridge stack (codex-bridge + lucky-mavis-server) up at user logon."

Write-Host ""
Write-Host "Installed. To run it now without rebooting:"
Write-Host "  Start-ScheduledTask -TaskName $taskName"
Write-Host ""
Write-Host "To remove later:"
Write-Host "  Unregister-ScheduledTask -TaskName $taskName -Confirm:`$false"
