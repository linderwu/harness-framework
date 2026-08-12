param(
  [ValidateSet("status", "sync", "activate-formal-domain", "restore-cloudflare")]
  [string] $Action = "status"
)

$ErrorActionPreference = "Stop"
$sshHost = if ($env:OPENCLAW_SSH_HOST) { $env:OPENCLAW_SSH_HOST } else { "192.168.28.128" }
$sshUser = if ($env:OPENCLAW_SSH_USER) { $env:OPENCLAW_SSH_USER } else { "linder" }

function Get-SshPassword {
  if ($env:OPENCLAW_SSH_PASSWORD) {
    return $env:OPENCLAW_SSH_PASSWORD
  }

  $passwordFile = $env:OPENCLAW_SSH_PASSWORD_FILE
  if (-not $passwordFile) {
    $passwordFile = Join-Path $PSScriptRoot "..\.secrets\openclaw-ssh-password.dpapi"
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

function Convert-ToWslPath([string] $windowsPath) {
  $drive = $windowsPath.Substring(0, 1).ToLowerInvariant()
  $rest = $windowsPath.Substring(2).Replace("\", "/")
  return "/mnt/$drive$rest"
}

function Invoke-Remote([string] $remoteScript) {
  $password = Get-SshPassword
  $knownHostsFile = Join-Path $env:USERPROFILE ".ssh\known_hosts"

  if (-not (Test-Path -LiteralPath $knownHostsFile)) {
    throw "Pinned SSH known_hosts file was not found at $knownHostsFile."
  }

  $remoteB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($remoteScript))
  $runner = New-TemporaryFile
  $runnerScript = @'
set -eu
password="$1"
remote_b64="$2"
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

  [IO.File]::WriteAllText($runner.FullName, $runnerScript, [Text.UTF8Encoding]::new($false))

  try {
    wsl bash (Convert-ToWslPath $runner.FullName) $password $remoteB64 $sshUser $sshHost (Convert-ToWslPath $knownHostsFile)
  } finally {
    Remove-Item -LiteralPath $runner.FullName -Force -ErrorAction SilentlyContinue
  }
}

$bridgeToken = if ($env:OPENCLAW_BRIDGE_TOKEN) {
  $env:OPENCLAW_BRIDGE_TOKEN
} else {
  $env:OPENCLAW_GATEWAY_TOKEN
}

if (-not $bridgeToken) {
  throw "Set OPENCLAW_BRIDGE_TOKEN or OPENCLAW_GATEWAY_TOKEN."
}

$tokenB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bridgeToken))

if ($Action -eq "sync") {
  $bridgeSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "openclaw-bridge.mjs")
  $bridgeB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bridgeSource))
  $lockSource = Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot "..\.harness\skill.lock.json")
  $lockB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($lockSource))
  $remoteScript = @'
set -eu
bridge_dir="$HOME/jormungandr-openclaw-bridge"
config_dir="$HOME/.config/jormungandr"
drop_in="$HOME/.config/systemd/user/jormungandr-openclaw-bridge.service.d"
mkdir -p "$bridge_dir" "$config_dir" "$drop_in"
if [ -f "$bridge_dir/openclaw-bridge.mjs" ]; then
  cp "$bridge_dir/openclaw-bridge.mjs" "$bridge_dir/openclaw-bridge.mjs.previous"
fi
if [ -f "$config_dir/skill.lock.json" ]; then
  cp "$config_dir/skill.lock.json" "$config_dir/skill.lock.json.previous"
fi
printf '%s' '__BRIDGE_B64__' | base64 -d > "$bridge_dir/openclaw-bridge.mjs"
printf '%s' '__LOCK_B64__' | base64 -d > "$config_dir/skill.lock.json"
bridge_token=$(printf '%s' '__TOKEN_B64__' | base64 -d)
{
  printf 'OPENCLAW_BRIDGE_TOKEN=%s\n' "$bridge_token"
  printf 'OPENCLAW_BRIDGE_PORT=4178\n'
  printf 'OPENCLAW_RUNTIME_SKILL_LOCK=%s\n' "$config_dir/skill.lock.json"
} > "$config_dir/openclaw-bridge.env"
chmod 600 "$config_dir/openclaw-bridge.env" "$config_dir/skill.lock.json"
printf '%s\n' '[Service]' "EnvironmentFile=$config_dir/openclaw-bridge.env" > "$drop_in/environment.conf"
systemctl --user daemon-reload
systemctl --user restart jormungandr-openclaw-bridge.service
sleep 3
systemctl --user is-active jormungandr-openclaw-bridge.service
curl -fsS -H "Authorization: Bearer $bridge_token" http://127.0.0.1:4178/health
printf '\n'
'@
  $remoteScript = $remoteScript.Replace("__BRIDGE_B64__", $bridgeB64)
  $remoteScript = $remoteScript.Replace("__LOCK_B64__", $lockB64)
  $remoteScript = $remoteScript.Replace("__TOKEN_B64__", $tokenB64)
  Invoke-Remote $remoteScript
  exit
}

if ($Action -eq "restore-cloudflare") {
  $remoteScript = @'
set -eu
existing=$(docker ps -aq --filter 'ancestor=cloudflare/cloudflared:latest' | head -n 1)
if [ -z "$existing" ]; then
  echo 'cloudflared container was not found' >&2
  exit 1
fi
tunnel_token=$(docker inspect "$existing" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^TUNNEL_TOKEN=//p' | head -n 1)
if [ -z "$tunnel_token" ]; then
  tunnel_token=$(docker inspect "$existing" --format '{{json .Config.Cmd}}' | python3 -c 'import json,sys; a=json.load(sys.stdin); print(a[a.index("--token")+1] if "--token" in a else "")')
fi
if [ -z "$tunnel_token" ]; then
  echo 'cloudflared tunnel token was not found' >&2
  exit 1
fi
existing_name=$(docker inspect "$existing" --format '{{.Name}}' | sed 's#^/##')
backup="${existing_name}-backup-$(date +%Y%m%d%H%M%S)"
docker rename "$existing_name" "$backup"
docker run -d --name cloudflared --network host --restart unless-stopped cloudflare/cloudflared:latest tunnel --no-autoupdate run --token "$tunnel_token" >/dev/null
sleep 8
docker ps --filter 'name=^/cloudflared$' --format 'CLOUDFLARED={{.Status}}'
printf 'BACKUP_CONTAINER=%s\n' "$backup"
'@
  Invoke-Remote $remoteScript
  exit
}

if ($Action -eq "activate-formal-domain") {
  $sudoPasswordB64 = [Convert]::ToBase64String(
    [Text.Encoding]::UTF8.GetBytes((Get-SshPassword))
  )
  $remoteScript = @'
set -eu
bridge_token=$(printf '%s' '__TOKEN_B64__' | base64 -d)
sudo_password=$(printf '%s' '__SUDO_PASSWORD_B64__' | base64 -d)
printf '%s\n' "$sudo_password" | sudo -S systemctl stop openclaw-bridge.service
printf '%s\n' "$sudo_password" | sudo -S systemctl disable openclaw-bridge.service >/dev/null
if systemctl is-active --quiet openclaw-bridge.service; then
  echo 'legacy openclaw-bridge.service is still active' >&2
  exit 1
fi
drop_in="$HOME/.config/systemd/user/jormungandr-openclaw-bridge.service.d"
mkdir -p "$drop_in"
printf '%s\n' '[Service]' 'Environment=OPENCLAW_BRIDGE_PORT=4178' > "$drop_in/formal-domain.conf"
systemctl --user daemon-reload
systemctl --user restart jormungandr-openclaw-bridge.service
sleep 4
if [ "$(systemctl --user is-active jormungandr-openclaw-bridge.service)" != "active" ]; then
  systemctl --user status jormungandr-openclaw-bridge.service --no-pager >&2 || true
  exit 1
fi
printf 'BRIDGE_SERVICE=active\n'
curl -fsS -H "Authorization: Bearer $bridge_token" http://127.0.0.1:4178/health
printf '\n'
'@
  $remoteScript = $remoteScript.Replace("__TOKEN_B64__", $tokenB64)
  $remoteScript = $remoteScript.Replace("__SUDO_PASSWORD_B64__", $sudoPasswordB64)
  Invoke-Remote $remoteScript
  exit
}

$remoteScript = @'
set -eu
bridge_token=$(printf '%s' '__TOKEN_B64__' | base64 -d)
bridge_status=$(systemctl --user is-active jormungandr-openclaw-bridge.service 2>/dev/null || true)
printf 'BRIDGE_SERVICE=%s\n' "$bridge_status"
printf 'LOCAL_HEALTH='
curl -fsS -H "Authorization: Bearer $bridge_token" http://127.0.0.1:4178/health || true
printf '\n'
docker ps --filter 'name=^/cloudflared$' --format 'CLOUDFLARED={{.Status}}'
'@
Invoke-Remote ($remoteScript.Replace("__TOKEN_B64__", $tokenB64))
