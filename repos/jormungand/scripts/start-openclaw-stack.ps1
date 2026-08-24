[CmdletBinding()]
param(
  [ValidateSet("install", "start", "status", "restart", "stop")]
  [string]$Action = "start",
  [switch]$VerifyPublic,
  [switch]$SkipHarnessConnection,
  [int]$LocalTunnelPort = 4188
)

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$projectRoot = (Resolve-Path (Join-Path $scriptDir "..")).Path
$remoteHost = if ($env:OPENCLAW_SSH_HOST) { $env:OPENCLAW_SSH_HOST } else { "192.168.50.1" }
$remoteUser = if ($env:OPENCLAW_SSH_USER) { $env:OPENCLAW_SSH_USER } else { "amr" }
$publicUrl = if ($env:OPENCLAW_BRIDGE_URL) {
  $env:OPENCLAW_BRIDGE_URL.TrimEnd("/")
} else {
  "https://openclaw-bridge.jormungandcycle.com"
}
$tunnelRoot = Join-Path $env:LOCALAPPDATA "Jormungand\openclaw-stack"
$tunnelPidFile = Join-Path $tunnelRoot "harness-tunnel.pid"
$tunnelLogFile = Join-Path $tunnelRoot "harness-tunnel.log"
$tunnelErrorFile = Join-Path $tunnelRoot "harness-tunnel.err.log"

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

      if (-not (Test-Path "Env:\$name") -and $value -notmatch '^\$\{') {
        Set-Item -Path "Env:\$name" -Value $value
      }
    }
}

Import-EnvFile (Join-Path $projectRoot "..\..\.env.local")

function Get-SshPassword {
  if ($env:OPENCLAW_SSH_PASSWORD) {
    return $env:OPENCLAW_SSH_PASSWORD
  }

  $passwordFile = $env:OPENCLAW_SSH_PASSWORD_FILE
  if (-not $passwordFile) {
    $passwordFile = Join-Path $projectRoot "..\..\.secrets\openclaw-ssh-password.dpapi"
  }

  if (-not (Test-Path -LiteralPath $passwordFile)) {
    throw "Set OPENCLAW_SSH_PASSWORD or OPENCLAW_SSH_PASSWORD_FILE."
  }

  $securePassword = (Get-Content -Raw -LiteralPath $passwordFile).Trim() | ConvertTo-SecureString
  $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  }
}

function Convert-ToWslPath([string]$windowsPath) {
  $drive = $windowsPath.Substring(0, 1).ToLowerInvariant()
  $rest = $windowsPath.Substring(2).Replace("\", "/")
  return "/mnt/$drive$rest"
}

function Convert-ToBase64([string]$value) {
  if ($null -eq $value) { $value = "" }
  return [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($value))
}

function Invoke-Remote([string]$remoteScript) {
  $knownHostsFile = Join-Path $env:USERPROFILE ".ssh\known_hosts"
  if (-not (Test-Path -LiteralPath $knownHostsFile)) {
    throw "Pinned SSH known_hosts file was not found at $knownHostsFile."
  }

  $password = Get-SshPassword
  $normalizedScript = $remoteScript.Replace("`r`n", "`n")
  $remoteB64 = Convert-ToBase64 $normalizedScript
  $runner = New-TemporaryFile
  $payloadFile = New-TemporaryFile
  [IO.File]::WriteAllText($payloadFile.FullName, $remoteB64, [Text.UTF8Encoding]::new($false))
  $runnerScript = @'
set -eu
password="$1"
remote_b64=$(cat "$2")
ssh_user="$3"
ssh_host="$4"
known_hosts="$5"
askpass=$(mktemp)
trap 'rm -f "$askpass"' EXIT
chmod 700 "$askpass"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$SSHPASS_VALUE"' > "$askpass"
printf '%s' "$remote_b64" | base64 -d |
  SSHPASS_VALUE="$password" \
  SSH_ASKPASS="$askpass" \
  SSH_ASKPASS_REQUIRE=force \
  DISPLAY=:0 \
  setsid ssh \
    -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$known_hosts" \
    -o ConnectTimeout=10 \
    "$ssh_user@$ssh_host" \
    'bash -s'
'@
  [IO.File]::WriteAllText(
    $runner.FullName,
    $runnerScript.Replace("`r`n", "`n"),
    [Text.UTF8Encoding]::new($false)
  )

  try {
    & wsl bash (Convert-ToWslPath $runner.FullName) `
      $password `
      (Convert-ToWslPath $payloadFile.FullName) `
      $remoteUser `
      $remoteHost `
      (Convert-ToWslPath $knownHostsFile)
    if ($LASTEXITCODE -ne 0) {
      throw "Remote OpenClaw stack command failed with exit code $LASTEXITCODE."
    }
  } finally {
    Remove-Item -LiteralPath $runner.FullName -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $payloadFile.FullName -Force -ErrorAction SilentlyContinue
  }
}

$gatewayToken = $env:OPENCLAW_GATEWAY_TOKEN
$bridgeToken = $env:OPENCLAW_BRIDGE_TOKEN
$healthToken = if ($bridgeToken) { $bridgeToken } else { $gatewayToken }

if ($Action -ne "stop" -and -not $healthToken) {
  throw "Set OPENCLAW_GATEWAY_TOKEN or OPENCLAW_BRIDGE_TOKEN."
}

function Get-LocalBridgeHealth {
  try {
    $headers = @{ Authorization = "Bearer $healthToken" }
    $result = Invoke-RestMethod `
      -Uri ("http://127.0.0.1:{0}/health" -f $LocalTunnelPort) `
      -Headers $headers `
      -TimeoutSec 3
    if ($result.ok -eq $true) { return $result }
  } catch {}
  return $null
}

function Stop-LocalHarnessTunnel {
  if (-not (Test-Path -LiteralPath $tunnelPidFile)) { return }

  $pidText = (Get-Content -Raw -LiteralPath $tunnelPidFile).Trim()
  $tunnelPid = 0
  if ([int]::TryParse($pidText, [ref]$tunnelPid) -and $tunnelPid -gt 0) {
    if (Get-Process -Id $tunnelPid -ErrorAction SilentlyContinue) {
      & taskkill.exe /PID $tunnelPid /T /F 2>$null | Out-Null
    }
  }
  Remove-Item -LiteralPath $tunnelPidFile -Force -ErrorAction SilentlyContinue
}

function Start-LocalHarnessTunnel {
  $existing = Get-LocalBridgeHealth
  if ($null -ne $existing) {
    Write-Host ("HARNESS_CONNECTION=connected url=http://127.0.0.1:{0}" -f $LocalTunnelPort)
    return
  }

  $occupied = Get-NetTCPConnection -State Listen -LocalPort $LocalTunnelPort -ErrorAction SilentlyContinue
  if ($occupied) {
    throw "Harness tunnel port $LocalTunnelPort is occupied, but its OpenClaw health endpoint is unavailable."
  }

  New-Item -ItemType Directory -Path $tunnelRoot -Force | Out-Null
  $knownHostsFile = Join-Path $env:USERPROFILE ".ssh\known_hosts"
  $password = Get-SshPassword
  $runnerPath = Join-Path $tunnelRoot "harness-tunnel.sh"
  $runnerScript = @'
set -eu
password="$1"
ssh_user="$2"
ssh_host="$3"
local_port="$4"
known_hosts="$5"
askpass=$(mktemp)
trap 'rm -f "$askpass"' EXIT
chmod 700 "$askpass"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$SSHPASS_VALUE"' > "$askpass"
SSHPASS_VALUE="$password" \
SSH_ASKPASS="$askpass" \
SSH_ASKPASS_REQUIRE=force \
DISPLAY=:0 \
setsid ssh -N \
  -L "127.0.0.1:${local_port}:127.0.0.1:4188" \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$known_hosts" \
  -o ServerAliveInterval=15 \
  -o ServerAliveCountMax=3 \
  -o ConnectTimeout=10 \
  "$ssh_user@$ssh_host"
'@
  [IO.File]::WriteAllText(
    $runnerPath,
    $runnerScript.Replace("`r`n", "`n"),
    [Text.UTF8Encoding]::new($false)
  )

  $process = Start-Process -FilePath "wsl.exe" `
    -ArgumentList @(
      "bash",
      (Convert-ToWslPath $runnerPath),
      $password,
      $remoteUser,
      $remoteHost,
      [string]$LocalTunnelPort,
      (Convert-ToWslPath $knownHostsFile)
    ) `
    -WorkingDirectory $projectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $tunnelLogFile `
    -RedirectStandardError $tunnelErrorFile `
    -PassThru
  Set-Content -LiteralPath $tunnelPidFile -Value $process.Id

  foreach ($attempt in 1..30) {
    Start-Sleep -Milliseconds 500
    $health = Get-LocalBridgeHealth
    if ($null -ne $health) {
      Write-Host ("HARNESS_CONNECTION=connected url=http://127.0.0.1:{0}" -f $LocalTunnelPort)
      return
    }
  }

  Stop-LocalHarnessTunnel
  throw "Harness SSH tunnel did not expose OpenClaw health on 127.0.0.1:$LocalTunnelPort."
}

function Get-SourceBase64([string]$name) {
  $path = Join-Path $scriptDir $name
  if (-not (Test-Path -LiteralPath $path)) {
    throw "Required bridge source is missing: $path"
  }
  return Convert-ToBase64 (Get-Content -Raw -LiteralPath $path)
}

$bridgeB64 = Get-SourceBase64 "openclaw-bridge.mjs"
$sessionB64 = Get-SourceBase64 "openclaw-session.mjs"
$permissionsB64 = Get-SourceBase64 "agent-permissions.mjs"
$quotaStoreB64 = Get-SourceBase64 "lucky-quota-store.mjs"
$lockPath = Join-Path $projectRoot ".harness\skill.lock.json"
$lockB64 = if (Test-Path -LiteralPath $lockPath) {
  Convert-ToBase64 (Get-Content -Raw -LiteralPath $lockPath)
} else {
  Convert-ToBase64 '{"lockedBundles":[]}'
}
$bridgeTokenB64 = Convert-ToBase64 $bridgeToken
$gatewayTokenB64 = Convert-ToBase64 $gatewayToken
$model = if ($env:OPENCLAW_A2A_MODEL) { $env:OPENCLAW_A2A_MODEL } else { "minimax-portal/MiniMax-M2.7" }
$modelB64 = Convert-ToBase64 $model
$healthTokenB64 = Convert-ToBase64 $healthToken
$sudoPasswordB64 = Convert-ToBase64 (Get-SshPassword)

$remoteScript = @'
set -eu
action="__ACTION__"
bridge_dir="$HOME/jormungandr-openclaw-bridge"
config_dir="$HOME/.config/jormungandr"
unit_dir="$HOME/.config/systemd/user"
unit="$unit_dir/jormungandr-openclaw-bridge.service"
sudo_password=$(printf '%s' '__SUDO_PASSWORD_B64__' | base64 -d)
mkdir -p "$bridge_dir" "$config_dir" "$unit_dir"

sudo_run() {
  printf '%s\n' "$sudo_password" | sudo -S -p '' "$@"
}

ensure_cloudflared() {
  if [ ! -s /etc/cloudflared/token ]; then
    return 0
  fi

  dropin_tmp=$(mktemp)
  cat > "$dropin_tmp" <<'DROPIN'
[Service]
Environment=TUNNEL_TRANSPORT_PROTOCOL=http2
Environment=TUNNEL_EDGE_IP_VERSION=4
Environment=TUNNEL_DNS_RESOLVER_ADDRS=1.1.1.1:53
DROPIN
  sudo_run install -d -m 755 /etc/systemd/system/cloudflared.service.d
  sudo_run install -o root -g root -m 644 "$dropin_tmp" /etc/systemd/system/cloudflared.service.d/transport.conf
  rm -f "$dropin_tmp"
  sudo_run systemctl daemon-reload
  sudo_run systemctl enable cloudflared.service >/dev/null
  sudo_run systemctl start --no-block cloudflared.service
}

install_bridge() {
  for file in openclaw-bridge.mjs openclaw-session.mjs agent-permissions.mjs lucky-quota-store.mjs; do
    if [ -f "$bridge_dir/$file" ]; then
      cp "$bridge_dir/$file" "$bridge_dir/$file.previous"
    fi
  done
  printf '%s' '__BRIDGE_B64__' | base64 -d > "$bridge_dir/openclaw-bridge.mjs"
  printf '%s' '__SESSION_B64__' | base64 -d > "$bridge_dir/openclaw-session.mjs"
  printf '%s' '__PERMISSIONS_B64__' | base64 -d > "$bridge_dir/agent-permissions.mjs"
  printf '%s' '__QUOTA_STORE_B64__' | base64 -d > "$bridge_dir/lucky-quota-store.mjs"
  printf '%s' '__LOCK_B64__' | base64 -d > "$config_dir/skill.lock.json"
  bridge_token=$(printf '%s' '__BRIDGE_TOKEN_B64__' | base64 -d)
  gateway_token=$(printf '%s' '__GATEWAY_TOKEN_B64__' | base64 -d)
  model=$(printf '%s' '__MODEL_B64__' | base64 -d)
  {
    printf 'OPENCLAW_BRIDGE_HOST=127.0.0.1\n'
    printf 'OPENCLAW_BRIDGE_PORT=4188\n'
    printf 'OPENCLAW_EXEC_MODE=host\n'
    printf 'OPENCLAW_BIN=%s\n' "$HOME/.nvm/versions/node/v24.19.0/bin/openclaw"
    printf 'OPENCLAW_A2A_MODEL=%s\n' "$model"
    printf 'OPENCLAW_BRIDGE_TOKEN=%s\n' "$bridge_token"
    printf 'OPENCLAW_GATEWAY_TOKEN=%s\n' "$gateway_token"
    printf 'OPENCLAW_RUNTIME_SKILL_LOCK=%s\n' "$config_dir/skill.lock.json"
  } > "$config_dir/openclaw-bridge.env"
  chmod 700 "$bridge_dir/openclaw-bridge.mjs"
  chmod 600 "$config_dir/openclaw-bridge.env" "$config_dir/skill.lock.json"
  cat > "$unit" <<UNIT
[Unit]
Description=OpenClaw native HTTP bridge
After=network-online.target openclaw-gateway.service
Wants=network-online.target openclaw-gateway.service

[Service]
Type=simple
Environment=HOME=$HOME
Environment=PATH=$HOME/.nvm/versions/node/v24.19.0/bin:/usr/local/bin:/usr/bin:/bin:$HOME/bin
EnvironmentFile=-$HOME/.openclaw/secrets/openclaw-bridge.env
EnvironmentFile=-$config_dir/openclaw-bridge.env
WorkingDirectory=$bridge_dir
ExecStart=$HOME/.nvm/versions/node/v24.19.0/bin/node $bridge_dir/openclaw-bridge.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable openclaw-gateway.service >/dev/null
  systemctl --user enable jormungandr-openclaw-bridge.service >/dev/null
}

if [ "$action" = "install" ] || {
  [ "$action" != "status" ] &&
  [ "$action" != "stop" ] &&
  [ ! -f "$unit" ]
}; then
  install_bridge
fi

if [ "$action" != "status" ] && [ "$action" != "stop" ]; then
  ensure_cloudflared
fi

case "$action" in
  install)
    systemctl --user start openclaw-gateway.service
    systemctl --user restart jormungandr-openclaw-bridge.service
    ;;
  start)
    systemctl --user start openclaw-gateway.service
    systemctl --user start jormungandr-openclaw-bridge.service
    ;;
  restart)
    systemctl --user restart openclaw-gateway.service
    systemctl --user restart jormungandr-openclaw-bridge.service
    ;;
  stop)
    systemctl --user stop jormungandr-openclaw-bridge.service || true
    systemctl --user stop openclaw-gateway.service || true
    ;;
  status)
    ;;
esac

gateway_active=$(systemctl --user is-active openclaw-gateway.service 2>/dev/null || true)
gateway_enabled=$(systemctl --user is-enabled openclaw-gateway.service 2>/dev/null || true)
bridge_active=$(systemctl --user is-active jormungandr-openclaw-bridge.service 2>/dev/null || true)
bridge_enabled=$(systemctl --user is-enabled jormungandr-openclaw-bridge.service 2>/dev/null || true)
bridge_pid=$(systemctl --user show jormungandr-openclaw-bridge.service -p MainPID --value 2>/dev/null || true)
bridge_command=$(ps -o args= -p "$bridge_pid" 2>/dev/null || true)
stale_wrappers=$(pgrep -af 'codex\.cmd app-server --stdio' 2>/dev/null || true)
cloudflared_active=$(systemctl is-active cloudflared.service 2>/dev/null || true)
cloudflared_enabled=$(systemctl is-enabled cloudflared.service 2>/dev/null || true)

gateway_health=""
bridge_health=""
attempts=30
if [ "$action" = "status" ] || [ "$action" = "stop" ]; then attempts=1; fi
attempt=1
while [ "$attempt" -le "$attempts" ]; do
  gateway_health=$(openclaw health --json 2>/dev/null || true)
  bridge_health=$(curl -fsS -H "Authorization: Bearer $(printf '%s' '__HEALTH_TOKEN_B64__' | base64 -d)" http://127.0.0.1:4188/health 2>/dev/null || true)
  if printf '%s' "$gateway_health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true' &&
     printf '%s' "$bridge_health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then
    break
  fi
  if [ "$attempt" -lt "$attempts" ]; then sleep 1; fi
  attempt=$((attempt + 1))
done

gateway_ok=false
bridge_ok=false
if printf '%s' "$gateway_health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then gateway_ok=true; fi
if printf '%s' "$bridge_health" | grep -q '"ok"[[:space:]]*:[[:space:]]*true'; then bridge_ok=true; fi

printf 'GATEWAY_SERVICE=%s\n' "$gateway_active"
printf 'GATEWAY_ENABLED=%s\n' "$gateway_enabled"
printf 'GATEWAY_HEALTH_OK=%s\n' "$gateway_ok"
printf 'BRIDGE_SERVICE=%s\n' "$bridge_active"
printf 'BRIDGE_ENABLED=%s\n' "$bridge_enabled"
printf 'BRIDGE_HEALTH_OK=%s\n' "$bridge_ok"
printf 'BRIDGE_MAIN_PID=%s\n' "$bridge_pid"
printf 'BRIDGE_MAIN_COMMAND=%s\n' "$bridge_command"
printf 'CODEX_APP_SERVER_WRAPPERS=%s\n' "$(printf '%s\n' "$stale_wrappers" | sed '/^$/d' | wc -l)"
printf 'CLOUDFLARED_SERVICE=%s\n' "$cloudflared_active"
printf 'CLOUDFLARED_ENABLED=%s\n' "$cloudflared_enabled"
printf 'BRIDGE_HEALTH=%s\n' "$bridge_health"

if [ "$action" != "stop" ]; then
  if [ "$gateway_active" != "active" ] || [ "$bridge_active" != "active" ] || [ "$gateway_ok" != "true" ] || [ "$bridge_ok" != "true" ]; then
    exit 1
  fi
  if [ -n "$stale_wrappers" ]; then
    printf '%s\n' 'Refusing success because codex.cmd app-server --stdio wrappers remain.' >&2
    exit 1
  fi
fi
'@

$remoteScript = $remoteScript.Replace("__ACTION__", $Action)
$remoteScript = $remoteScript.Replace("__BRIDGE_B64__", $bridgeB64)
$remoteScript = $remoteScript.Replace("__SESSION_B64__", $sessionB64)
$remoteScript = $remoteScript.Replace("__PERMISSIONS_B64__", $permissionsB64)
$remoteScript = $remoteScript.Replace("__QUOTA_STORE_B64__", $quotaStoreB64)
$remoteScript = $remoteScript.Replace("__LOCK_B64__", $lockB64)
$remoteScript = $remoteScript.Replace("__BRIDGE_TOKEN_B64__", $bridgeTokenB64)
$remoteScript = $remoteScript.Replace("__GATEWAY_TOKEN_B64__", $gatewayTokenB64)
$remoteScript = $remoteScript.Replace("__MODEL_B64__", $modelB64)
$remoteScript = $remoteScript.Replace("__HEALTH_TOKEN_B64__", $healthTokenB64)
$remoteScript = $remoteScript.Replace("__SUDO_PASSWORD_B64__", $sudoPasswordB64)

Write-Host ("OpenClaw stack action={0} target={1}@{2}" -f $Action, $remoteUser, $remoteHost)
Invoke-Remote $remoteScript

if ($Action -eq "stop") {
  if (-not $SkipHarnessConnection) { Stop-LocalHarnessTunnel }
  exit 0
}

if ($SkipHarnessConnection) {
  Write-Host "HARNESS_CONNECTION=skipped"
} elseif ($Action -eq "status") {
  if ($null -eq (Get-LocalBridgeHealth)) {
    Write-Host "HARNESS_CONNECTION=offline"
    throw "Harness local tunnel is not connected."
  }
  Write-Host ("HARNESS_CONNECTION=connected url=http://127.0.0.1:{0}" -f $LocalTunnelPort)
} else {
  Start-LocalHarnessTunnel
}

if ($Action -ne "stop") {
  try {
    $headers = @{ Authorization = "Bearer $healthToken" }
    $response = Invoke-WebRequest -Uri "$publicUrl/health" -Headers $headers -TimeoutSec 10 -UseBasicParsing
    Write-Host ("PUBLIC_HEALTH=HTTP {0}" -f [int]$response.StatusCode)
    if ($VerifyPublic -and [int]$response.StatusCode -ne 200) {
      throw "Public OpenClaw bridge health was not HTTP 200."
    }
  } catch {
    $status = if ($_.Exception.Response) { [int]$_.Exception.Response.StatusCode } else { "unavailable" }
    Write-Host ("PUBLIC_HEALTH={0}" -f $status)
    if ($VerifyPublic) { throw }
  }
}
