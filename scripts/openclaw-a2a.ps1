$ErrorActionPreference = "Stop"
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$payloadFile = New-TemporaryFile
$payload = [Console]::In.ReadToEnd()
[System.IO.File]::WriteAllText(
  $payloadFile.FullName,
  $payload,
  [System.Text.UTF8Encoding]::new($false)
)

$sshHost = $env:OPENCLAW_SSH_HOST
if (-not $sshHost) {
  $sshHost = "192.168.28.128"
}

$sshUser = $env:OPENCLAW_SSH_USER
if (-not $sshUser) {
  $sshUser = "linder"
}

$sshPassword = $env:OPENCLAW_SSH_PASSWORD
if (-not $sshPassword) {
  $passwordFile = $env:OPENCLAW_SSH_PASSWORD_FILE
  if (-not $passwordFile) {
    $passwordFile = Join-Path $PSScriptRoot "..\.secrets\openclaw-ssh-password.dpapi"
  }

  if (Test-Path -LiteralPath $passwordFile) {
    $encryptedPassword = (Get-Content -Raw -LiteralPath $passwordFile).Trim()
    $securePassword = $encryptedPassword | ConvertTo-SecureString
    $passwordPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)

    try {
      $sshPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPtr)
    } finally {
      [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPtr)
    }
  }
}

if (-not $sshPassword) {
  throw "OPENCLAW_SSH_PASSWORD or OPENCLAW_SSH_PASSWORD_FILE is required."
}

$container = $env:OPENCLAW_CONTAINER
if (-not $container) {
  $container = "openclaw"
}

$agent = $env:OPENCLAW_A2A_AGENT
if (-not $agent) {
  $agent = "rowlet"
}

$model = $env:OPENCLAW_A2A_MODEL
if (-not $model) {
  $model = "minimax/MiniMax-M2.7"
}

$sessionKey = $env:OPENCLAW_A2A_SESSION_KEY
if (-not $sessionKey) {
  $sessionKey = "agent:${agent}:a2a-codex-$([guid]::NewGuid().ToString('N'))"
}

$timeoutSeconds = $env:OPENCLAW_A2A_AGENT_TIMEOUT_SECONDS
if (-not $timeoutSeconds) {
  $timeoutSeconds = "300"
}

function Convert-ToWslPath([string] $path) {
  $drive = $path.Substring(0, 1).ToLowerInvariant()
  $rest = $path.Substring(2).Replace("\", "/")
  return "/mnt/$drive$rest"
}

$wslPayloadPath = Convert-ToWslPath $payloadFile.FullName

$wslScript = @'
set -eu
payload_path="$1"
ssh_password="$2"
ssh_user="$3"
ssh_host="$4"
container="$5"
agent="$6"
model="$7"
session_key="$8"
timeout_seconds="$9"

askpass=$(mktemp)
chmod 700 "$askpass"
printf '%s\n' '#!/bin/sh' 'printf "%s\n" "$SSHPASS_VALUE"' > "$askpass"
payload_b64=$(base64 -w0 "$payload_path")

remote_script=$(cat <<EOS
set -eu
payload=\$(printf '%s' '$payload_b64' | base64 -d)
openclaw agent \
  --agent '$agent' \
  --model '$model' \
  --session-key '$session_key' \
  --message "\$payload" \
  --json \
  --timeout '$timeout_seconds'
EOS
)

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
    "docker exec -i $container sh -s"

rm -f "$askpass"
'@

try {
  $wslScript | wsl bash -s -- `
    $wslPayloadPath `
    $sshPassword `
    $sshUser `
    $sshHost `
    $container `
    $agent `
    $model `
    $sessionKey `
    $timeoutSeconds
} finally {
  Remove-Item -LiteralPath $payloadFile.FullName -Force -ErrorAction SilentlyContinue
}
