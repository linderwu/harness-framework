param(
[ValidateSet("bridge-logs", "cloudflare-check", "configure-agent-auth", "configure-bridge-port", "configure-domain", "install", "logs", "reset-tunnel", "status", "stop", "sync-openclaw-bridge", "verify-container-auth", "start", "restart")]
  [string] $Action = "start"
)

$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$sshHost = $env:OPENCLAW_SSH_HOST
if (-not $sshHost) {
  $sshHost = "192.168.28.128"
}

$sshUser = $env:OPENCLAW_SSH_USER
if (-not $sshUser) {
  $sshUser = "linder"
}

function Get-OpenClawSshPassword {
  if ($env:OPENCLAW_SSH_PASSWORD) {
    return $env:OPENCLAW_SSH_PASSWORD
  }

  $passwordFile = $env:OPENCLAW_SSH_PASSWORD_FILE
  if (-not $passwordFile) {
    $passwordFile = Join-Path $PSScriptRoot "..\.secrets\openclaw-ssh-password.dpapi"
  }

  if (-not (Test-Path -LiteralPath $passwordFile)) {
    throw "OpenClaw SSH password is missing. Set OPENCLAW_SSH_PASSWORD or create $passwordFile."
  }

  $encryptedPassword = (Get-Content -Raw -LiteralPath $passwordFile).Trim()
  $securePassword = $encryptedPassword | ConvertTo-SecureString
  $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

  try {
    return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
  }
}

function Convert-ToWslPath([string] $path) {
  $drive = $path.Substring(0, 1).ToLowerInvariant()
  $rest = $path.Substring(2).Replace("\", "/")
  return "/mnt/$drive$rest"
}

function Invoke-OpenClawRemoteScript([string] $remoteScript) {
  $sshPassword = Get-OpenClawSshPassword
  $remoteScript = $remoteScript -replace "`r`n", "`n"
  $remoteB64 = [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($remoteScript))
  $runner = New-TemporaryFile
  $runnerScript = @'
set -eu
ssh_password="$1"
remote_b64="$2"
ssh_user="$3"
ssh_host="$4"

askpass=$(mktemp)
chmod 700 "$askpass"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$SSHPASS_VALUE"' > "$askpass"
remote_script=$(printf '%s' "$remote_b64" | base64 -d)

printf '%s\n' "$remote_script" |
  SSHPASS_VALUE="$ssh_password" \
  SSH_ASKPASS="$askpass" \
  SSH_ASKPASS_REQUIRE=force \
  DISPLAY=:0 \
  setsid ssh \
    -o StrictHostKeyChecking=accept-new \
    -o UserKnownHostsFile=/tmp/codex_known_hosts_openclaw \
    -o ConnectTimeout=10 \
    "$ssh_user@$ssh_host" \
    'bash -s'

rm -f "$askpass"
'@
  $runnerScript = $runnerScript -replace "`r`n", "`n"

  [System.IO.File]::WriteAllText(
    $runner.FullName,
    $runnerScript,
    [System.Text.UTF8Encoding]::new($false)
  )

  try {
    $wslRunner = Convert-ToWslPath $runner.FullName
    wsl bash $wslRunner $sshPassword $remoteB64 $sshUser $sshHost
  } finally {
    Remove-Item -LiteralPath $runner.FullName -Force -ErrorAction SilentlyContinue
  }
}

$remoteScriptTemplate = @'
set -eu

action="__ACTION__"
bridge_service=jormungandr-openclaw-bridge.service

if [ "$action" = "configure-agent-auth" ]; then
  auth_dir="$HOME/.config/jormungandr"
  auth_file="$auth_dir/openclaw-agent.env"
  mkdir -p "$auth_dir"
  printf '%s' '__AUTH_USERNAME_B64__' | base64 -d > "$auth_dir/.username"
  printf '%s' '__AUTH_PASSWORD_B64__' | base64 -d > "$auth_dir/.password"
  {
    printf 'SITE_AUTH_USERNAME='; cat "$auth_dir/.username"; printf '\n'
    printf 'SITE_AUTH_PASSWORD='; cat "$auth_dir/.password"; printf '\n'
  } > "$auth_file"
  chmod 600 "$auth_dir/.username" "$auth_dir/.password" "$auth_file"
  rm -f "$auth_dir/.username" "$auth_dir/.password"
  drop_in="$HOME/.config/systemd/user/jormungandr-openclaw-bridge.service.d"
  mkdir -p "$drop_in"
  printf '%s\n' '[Service]' "EnvironmentFile=$auth_file" "Environment=OPENCLAW_SITE_AUTH_FILE=$auth_file" > "$drop_in/auth.conf"
  systemctl --user daemon-reload
  systemctl --user restart "$bridge_service"
  printf 'OPENCLAW_AUTH_CONFIGURED=true\n'
  printf 'AUTH_FILE_MODE='
  stat -c '%a' "$auth_file"
  systemctl --user show "$bridge_service" -p Environment --value | grep -q 'SITE_AUTH_USERNAME=' && printf 'SERVICE_USERNAME_PRESENT=true\n' || printf 'SERVICE_USERNAME_PRESENT=false\n'
  systemctl --user show "$bridge_service" -p Environment --value | grep -q 'SITE_AUTH_PASSWORD=' && printf 'SERVICE_PASSWORD_PRESENT=true\n' || printf 'SERVICE_PASSWORD_PRESENT=false\n'
  systemctl --user show "$bridge_service" -p EnvironmentFiles --value | grep -q 'openclaw-agent.env' && printf 'SERVICE_AUTH_FILE_LOADED=true\n' || printf 'SERVICE_AUTH_FILE_LOADED=false\n'
  systemctl --user cat "$bridge_service" | sed -E 's/(SITE_AUTH_PASSWORD|OPENCLAW_SITE_AUTH_FILE)=([^ ]+)/\1=<redacted>/g'
  exit 0
fi

if [ "$action" = "sync-openclaw-bridge" ]; then
  bridge_dir="$HOME/jormungandr-openclaw-bridge"
  mkdir -p "$bridge_dir"
  printf '%s' '__BRIDGE_MJS_B64__' | base64 -d > "$bridge_dir/openclaw-bridge.mjs"
  chmod 700 "$bridge_dir/openclaw-bridge.mjs"
  systemctl --user restart "$bridge_service"
  printf 'OPENCLAW_BRIDGE_SYNCED=true\n'
  exit 0
fi

if [ "$action" = "verify-container-auth" ]; then
  auth_file="$HOME/.config/jormungandr/openclaw-agent.env"
  set -a
  . "$auth_file"
  set +a
  docker exec -e "SITE_AUTH_USERNAME=$SITE_AUTH_USERNAME" -e "SITE_AUTH_PASSWORD=$SITE_AUTH_PASSWORD" openclaw sh -lc 'test -n "$SITE_AUTH_USERNAME" && test -n "$SITE_AUTH_PASSWORD"'
  printf 'CONTAINER_AUTH_PRESENT=true\n'
  exit 0
fi

if [ "$action" = "bridge-logs" ]; then
  systemctl --user cat "$bridge_service" || true
  systemctl --user show "$bridge_service" -p Environment --value || true
  systemctl --user status "$bridge_service" --no-pager || true
  journalctl --user -u "$bridge_service" -n 100 --no-pager || true
  printf 'LISTENING='; ss -ltn '( sport = :4188 )' | tail -n +2 || true
  exit 0
fi

if [ "$action" = "configure-bridge-port" ]; then
  drop_in="$HOME/.config/systemd/user/jormungandr-openclaw-bridge.service.d"
  mkdir -p "$drop_in"
  bridge_env="$HOME/.config/jormungandr/openclaw-bridge.env"
  if [ -f "$bridge_env" ]; then
    sed -i '/^OPENCLAW_BRIDGE_PORT=/d' "$bridge_env"
  fi
  printf 'OPENCLAW_BRIDGE_PORT=4188\n' >> "$bridge_env"
  rm -f "$drop_in/formal-domain.conf"
  printf '%s\n' '[Service]' 'Environment=OPENCLAW_BRIDGE_PORT=4188' > "$drop_in/port.conf"
  systemctl --user daemon-reload
  systemctl --user restart "$bridge_service"
  printf 'OPENCLAW_BRIDGE_PORT=4188\n'
  exit 0
fi
tunnel_service=jormungandr-openclaw-ngrok.service
public_domain=openclaw-bridge.jormungandcycle.com

configure_tunnel_domain() {
  service_path="$HOME/.config/systemd/user/$tunnel_service"
  mkdir -p "$(dirname "$service_path")"
  cat > "$service_path" <<SERVICE
[Unit]
Description=OpenClaw ngrok tunnel for Jormungandr bridge
After=network-online.target $bridge_service
Wants=network-online.target $bridge_service

[Service]
Type=simple
ExecStart=/usr/local/bin/ngrok http --log=stdout --log-format=json --domain=$public_domain 4188
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

  systemctl --user daemon-reload
  systemctl --user enable "$tunnel_service"
  printf 'CONFIGURED_NGROK_DOMAIN=%s\n' "$public_domain"
}

reset_tunnel_domain() {
  service_path="$HOME/.config/systemd/user/$tunnel_service"
  mkdir -p "$(dirname "$service_path")"
  cat > "$service_path" <<SERVICE
[Unit]
Description=OpenClaw ngrok tunnel for Jormungandr bridge
After=network-online.target $bridge_service
Wants=network-online.target $bridge_service

[Service]
Type=simple
ExecStart=/usr/local/bin/ngrok http --log=stdout --log-format=json 4188
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

  systemctl --user daemon-reload
  systemctl --user enable "$tunnel_service"
  printf 'RESET_NGROK_DOMAIN=dynamic\n'
}

install_vm_wrapper() {
  mkdir -p "$HOME/bin"
  script_path="$HOME/bin/openclaw-bridge"
  tmp_path="$(mktemp)"
  cat > "$tmp_path" <<'SCRIPT'
#!/usr/bin/env bash
set -euo pipefail

action="${1:-start}"
bridge_service="jormungandr-openclaw-bridge.service"
tunnel_service="jormungandr-openclaw-ngrok.service"
public_domain="openclaw-bridge.jormungandcycle.com"

configure_tunnel_domain() {
  service_path="$HOME/.config/systemd/user/$tunnel_service"
  mkdir -p "$(dirname "$service_path")"
  cat > "$service_path" <<SERVICE
[Unit]
Description=OpenClaw ngrok tunnel for Jormungandr bridge
After=network-online.target $bridge_service
Wants=network-online.target $bridge_service

[Service]
Type=simple
ExecStart=/usr/local/bin/ngrok http --log=stdout --log-format=json --domain=$public_domain 4188
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
SERVICE

  systemctl --user daemon-reload
  systemctl --user enable "$tunnel_service"
  printf 'CONFIGURED_NGROK_DOMAIN=%s\n' "$public_domain"
}

case "$action" in
  configure-domain)
    configure_tunnel_domain
    systemctl --user restart "$bridge_service"
    systemctl --user restart "$tunnel_service"
    ;;
  start)
    systemctl --user start "$bridge_service"
    systemctl --user start "$tunnel_service"
    ;;
  restart)
    systemctl --user restart "$bridge_service"
    systemctl --user restart "$tunnel_service"
    ;;
  stop)
    systemctl --user stop "$tunnel_service" || true
    systemctl --user stop "$bridge_service" || true
    ;;
  status)
    ;;
  *)
    echo "Usage: openclaw-bridge [configure-domain|start|restart|status|stop]" >&2
    exit 2
    ;;
esac

if [ "$action" != "stop" ]; then
  sleep 3
fi

bridge_active=$(systemctl --user is-active "$bridge_service" 2>/dev/null || true)
tunnel_active=$(systemctl --user is-active "$tunnel_service" 2>/dev/null || true)
bridge_enabled=$(systemctl --user is-enabled "$bridge_service" 2>/dev/null || true)
tunnel_enabled=$(systemctl --user is-enabled "$tunnel_service" 2>/dev/null || true)

printf 'BRIDGE_SERVICE=%s\n' "$bridge_active"
printf 'BRIDGE_ENABLED=%s\n' "$bridge_enabled"
printf 'TUNNEL_SERVICE=%s\n' "$tunnel_active"
printf 'TUNNEL_ENABLED=%s\n' "$tunnel_enabled"

if [ "$action" = "stop" ]; then
  exit 0
fi

printf 'LOCAL_HEALTH='
curl -fsS http://127.0.0.1:4188/health || true
printf '\n'

public_url=$(python3 - <<'PY'
import json
import urllib.request

try:
    data = json.load(urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=3))
    tunnels = data.get("tunnels", [])
    https = [t for t in tunnels if t.get("proto") == "https"]
    if https:
        print(https[0]["public_url"])
except Exception:
    pass
PY
)

if [ -n "$public_url" ]; then
  printf 'OPENCLAW_BRIDGE_URL=%s\n' "$public_url"
  printf 'PUBLIC_HEALTH='
  curl -fsS -H 'ngrok-skip-browser-warning: true' "$public_url/health" || true
  printf '\n'
else
  printf 'OPENCLAW_BRIDGE_URL=\n'
  printf 'PUBLIC_HEALTH=unavailable\n'
fi
SCRIPT
  install -m 0755 "$tmp_path" "$script_path"
  rm -f "$tmp_path"

  if ! grep -qs 'export PATH="$HOME/bin:$PATH"' "$HOME/.profile"; then
    printf '\n# User scripts\nexport PATH="$HOME/bin:$PATH"\n' >> "$HOME/.profile"
  fi

  printf 'INSTALLED=%s\n' "$script_path"
}

if [ "$action" = "install" ]; then
  install_vm_wrapper
  "$HOME/bin/openclaw-bridge" status
  exit 0
fi

if [ "$action" = "logs" ]; then
  systemctl --user status "$tunnel_service" --no-pager || true
  journalctl --user -u "$tunnel_service" -n 80 --no-pager || true
  exit 0
fi

if [ "$action" = "cloudflare-check" ]; then
  if command -v cloudflared >/dev/null 2>&1; then
    printf 'CLOUDFLARED=%s\n' "$(command -v cloudflared)"
    cloudflared tunnel list || true
  else
    printf 'CLOUDFLARED=not-found\n'
  fi

  for path in "$HOME/.cloudflared" "$HOME/.cloudflare-warp"; do
    if [ -e "$path" ]; then
      printf 'CLOUDFLARE_PATH=%s\n' "$path"
      ls -la "$path" || true
    fi
  done
  exit 0
fi

case "$action" in
  configure-domain)
    configure_tunnel_domain
    install_vm_wrapper
    systemctl --user restart "$bridge_service"
    systemctl --user restart "$tunnel_service"
    ;;
  reset-tunnel)
    reset_tunnel_domain
    systemctl --user restart "$bridge_service"
    systemctl --user restart "$tunnel_service"
    ;;
  start)
    systemctl --user start "$bridge_service"
    systemctl --user start "$tunnel_service"
    ;;
  restart)
    systemctl --user restart "$bridge_service"
    systemctl --user restart "$tunnel_service"
    ;;
  stop)
    systemctl --user stop "$tunnel_service" || true
    systemctl --user stop "$bridge_service" || true
    ;;
  status)
    ;;
esac

if [ "$action" != "stop" ]; then
  sleep 3
fi

bridge_active=$(systemctl --user is-active "$bridge_service" 2>/dev/null || true)
tunnel_active=$(systemctl --user is-active "$tunnel_service" 2>/dev/null || true)
bridge_enabled=$(systemctl --user is-enabled "$bridge_service" 2>/dev/null || true)
tunnel_enabled=$(systemctl --user is-enabled "$tunnel_service" 2>/dev/null || true)

printf 'BRIDGE_SERVICE=%s\n' "$bridge_active"
printf 'BRIDGE_ENABLED=%s\n' "$bridge_enabled"
printf 'TUNNEL_SERVICE=%s\n' "$tunnel_active"
printf 'TUNNEL_ENABLED=%s\n' "$tunnel_enabled"

if [ "$action" = "stop" ]; then
  exit 0
fi

printf 'LOCAL_HEALTH='
curl -fsS http://127.0.0.1:4188/health || true
printf '\n'

public_url=$(python3 - <<'PY'
import json
import urllib.request

try:
    data = json.load(urllib.request.urlopen("http://127.0.0.1:4040/api/tunnels", timeout=3))
    tunnels = data.get("tunnels", [])
    https = [t for t in tunnels if t.get("proto") == "https"]
    if https:
        print(https[0]["public_url"])
except Exception:
    pass
PY
)

if [ -n "$public_url" ]; then
  printf 'OPENCLAW_BRIDGE_URL=%s\n' "$public_url"
  printf 'PUBLIC_HEALTH='
  curl -fsS -H 'ngrok-skip-browser-warning: true' "$public_url/health" || true
  printf '\n'
else
  printf 'OPENCLAW_BRIDGE_URL=\n'
  printf 'PUBLIC_HEALTH=unavailable\n'
fi
'@

$remoteScript = $remoteScriptTemplate.Replace("__ACTION__", $Action)

if ($Action -eq "configure-agent-auth") {
  $authUsername = (Get-Content -Raw (Join-Path $env:USERPROFILE ".codex\secrets\jormungand-basic-auth.username")).Trim()
  $authEncrypted = (Get-Content -Raw (Join-Path $env:USERPROFILE ".codex\secrets\jormungand-basic-auth.dpapi")).Trim()
  $authSecure = $authEncrypted | ConvertTo-SecureString
  $authPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($authSecure)
  try {
    $authPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($authPointer)
  } finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($authPointer)
  }
  $usernameB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($authUsername))
  $passwordB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($authPassword))
  $remoteScript = $remoteScript.Replace("__AUTH_USERNAME_B64__", $usernameB64).Replace("__AUTH_PASSWORD_B64__", $passwordB64)
}

if ($Action -eq "sync-openclaw-bridge") {
  $bridgeSource = Get-Content -Raw (Join-Path $PSScriptRoot "openclaw-bridge.mjs")
  $bridgeB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($bridgeSource))
  $remoteScript = $remoteScript.Replace("__BRIDGE_MJS_B64__", $bridgeB64)
}

Invoke-OpenClawRemoteScript $remoteScript
