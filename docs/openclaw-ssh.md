# OpenClaw SSH Connection

Status: active local profile

## Host

```txt
OPENCLAW_SSH_USER=linder
OPENCLAW_SSH_HOST=192.168.28.128
OPENCLAW_CONTAINER=openclaw
```

## A2A Sessions

```txt
Each invocation uses `agent:<agent>:a2a-codex-<event>-<attempt>`.
```

Default models verified on 2026-07-19:

```txt
rowlet      -> minimax-portal/MiniMax-M2.7
roaringmoon -> minimax-portal/MiniMax-M2.7
charizard   -> minimax-portal/MiniMax-M3
mrmime      -> minimax-portal/MiniMax-M2.7
mrmine      -> minimax-portal/MiniMax-M2.7
gengar      -> minimax-portal/MiniMax-M2.7
```

## Local Secret Storage

The SSH password is not stored in this repository. The local wrapper reads it
from one of these sources:

1. `OPENCLAW_SSH_PASSWORD`
2. `OPENCLAW_SSH_PASSWORD_FILE`
3. `.secrets/openclaw-ssh-password.dpapi`

The `.dpapi` file is encrypted with Windows DPAPI for the current Windows user
and is excluded from git by `.gitignore`.

## Wrapper Command

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\linder\Documents\harness框架\scripts\openclaw-a2a.ps1
```

Set this as:

```powershell
$env:OPENCLAW_A2A_COMMAND = "powershell -NoProfile -ExecutionPolicy Bypass -File C:\Users\linder\Documents\harness框架\scripts\openclaw-a2a.ps1"
```

The wrapper reads an A2A JSON envelope from stdin and sends it to:

```sh
ssh linder@192.168.28.128
docker exec -i openclaw openclaw agent --agent "$OPENCLAW_A2A_AGENT" --model "$OPENCLAW_A2A_MODEL" --session-key "$OPENCLAW_A2A_SESSION_KEY" --message "$payload" --json
```

## Zeabur Liveness

The protected dashboard at `https://jormungand.zeabur.app/` requires Basic
Auth. Agents can verify network and app availability without credentials at:

```txt
https://jormungand.zeabur.app/api/agent-health
```

Expected result after deployment:

```json
{
  "ok": true,
  "service": "jormungandr",
  "endpoint": "agent-health",
  "protectedAppRequiresBasicAuth": true
}
```

## Remote Bridge Start Script

Use this from the local Windows repo to start or check the OpenClaw bridge on
`192.168.28.128`:

```powershell
npm run openclaw-bridge:remote
```

Equivalent direct command:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-openclaw-bridge.ps1
```

Supported actions:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-openclaw-bridge.ps1 -Action install
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-openclaw-bridge.ps1 -Action start
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-openclaw-bridge.ps1 -Action restart
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-openclaw-bridge.ps1 -Action status
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-openclaw-bridge.ps1 -Action stop
```

The script:

1. Reads the SSH password from `.secrets/openclaw-ssh-password.dpapi` unless
   `OPENCLAW_SSH_PASSWORD` is set.
2. SSHes to `linder@192.168.28.128`.
3. Starts/checks these user services:
   - `jormungandr-openclaw-bridge.service`
   - `jormungandr-openclaw-ngrok.service`
4. Prints the current `OPENCLAW_BRIDGE_URL`.
5. Checks local and public bridge health.

If ngrok is not using a reserved/static domain, `OPENCLAW_BRIDGE_URL` may change
after the tunnel restarts. When it changes, update the Zeabur app environment
variable:

```txt
OPENCLAW_BRIDGE_URL=https://openclaw-bridge.jormungandcycle.com
```

`OPENCLAW_BRIDGE_TOKEN` does not change unless the bridge token is rotated.

Target public bridge URL:

```txt
https://openclaw-bridge.jormungandcycle.com
```

The current ngrok account cannot directly serve that hostname on the free plan;
ngrok returns `ERR_NGROK_314` for custom hostnames. Use a Cloudflare Tunnel for
this domain, or upgrade ngrok before running:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-openclaw-bridge.ps1 -Action configure-domain
```

## VM Direct Bridge Script

The VM also has a direct wrapper installed at:

```sh
/home/linder/bin/openclaw-bridge
```

After SSHing into `linder@192.168.28.128`, use:

```sh
openclaw-bridge
openclaw-bridge status
openclaw-bridge restart
openclaw-bridge stop
```

If the shell cannot find it yet, either log out and SSH in again, or call it
with the full path:

```sh
~/bin/openclaw-bridge status
```

The VM wrapper controls the same user services:

```txt
jormungandr-openclaw-bridge.service
jormungandr-openclaw-ngrok.service
```
