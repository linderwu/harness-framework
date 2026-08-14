# Local Codex Bridge

The dashboard records `codex`, concrete OpenClaw profiles, and `manual` as workflow executors. To make `codex` execute on this machine, run the local bridge and point the app at it.

## Local Development

Terminal 1:

```powershell
npm run codex-bridge
```

Terminal 2:

```powershell
$env:CODEX_BRIDGE_URL = "http://127.0.0.1:4177"
npm run dev
```

When a workflow event is assigned to `codex`, the Next.js API calls `POST /agent-runs` on the bridge. The bridge runs:

```powershell
codex exec -c service_tier="fast" -C <repo> --sandbox workspace-write -
```

Without `CODEX_BRIDGE_URL`, non-manual agents fail closed by default instead of
silently creating simulated artifacts. Set `HARNESS_ALLOW_SIMULATED_AGENTS=1`
only when you intentionally want local demo artifacts instead of a real agent
run.

OpenClaw profiles use ids such as `openclaw.rowlet`, `openclaw.roaringmoon`,
`openclaw.charizard`, `openclaw.mrmime`, `openclaw.mrmine`, and
`openclaw.gengar`. When one is assigned, the Next.js
API calls `OPENCLAW_BRIDGE_URL` and includes `mainAgent` in the payload.

## OpenClaw A2A Command

OpenClaw can also run through an A2A command adapter. Set
`OPENCLAW_A2A_COMMAND` to a local command that reads a JSON envelope from stdin
and writes either OpenClaw `--json` output or plain text to stdout.

The command adapter supports two envelope modes:

```txt
OPENCLAW_A2A_PROTOCOL=legacy-clawcodex-v0.1
OPENCLAW_A2A_PROTOCOL=public-a2a-v0.3
```

`legacy-clawcodex-v0.1` is the default so existing local SSH/container wrappers
keep working. `public-a2a-v0.3` emits a JSON-RPC 2.0 `message/send` request
using the Linux Foundation Agent2Agent protocol shape. New integrations should
target `public-a2a-v0.3`; the legacy envelope is kept only as a compatibility
transport while OpenClaw does not yet expose a native public A2A server.

The app passes these environment variables to the command:

```txt
OPENCLAW_A2A_AGENT=rowlet|roaringmoon|charizard|mrmime|mrmine|gengar
OPENCLAW_A2A_MODEL=minimax/MiniMax-M2.7
OPENCLAW_A2A_SESSION_KEY=agent:<agent>:a2a-codex-<event>-<attempt>
OPENCLAW_A2A_PROTOCOL=legacy-clawcodex-v0.1
```

Example shape for the command:

```powershell
$env:OPENCLAW_A2A_COMMAND = "wsl bash ~/bin/openclaw-a2a.sh"
```

That script should perform the SSH/container hop and send stdin as the
`openclaw agent --message` payload:

```sh
openclaw agent \
  --agent "$OPENCLAW_A2A_AGENT" \
  --model "$OPENCLAW_A2A_MODEL" \
  --session-key "$OPENCLAW_A2A_SESSION_KEY" \
  --message "$payload" \
  --json
```

Use `OPENCLAW_BRIDGE_URL` for an HTTP request/response bridge. Use
`OPENCLAW_A2A_COMMAND` when you want the persistent session-based A2A transport.

## OpenClaw Bridge On 192.168.28.128

Use this when the Zeabur app needs to call OpenClaw. Zeabur cannot run the local
PowerShell `OPENCLAW_A2A_COMMAND`, so it needs a public HTTPS URL that forwards
to an HTTP bridge on the OpenClaw VM.

On `192.168.28.128`:

```sh
cd /path/to/harness-framework
export OPENCLAW_BRIDGE_HOST=127.0.0.1
export OPENCLAW_BRIDGE_PORT=4188
export OPENCLAW_BRIDGE_TOKEN='<same secret configured in Zeabur OPENCLAW_BRIDGE_TOKEN>'
export OPENCLAW_CONTAINER=openclaw
npm run openclaw-bridge
```

Health check from the VM:

```sh
curl http://127.0.0.1:4188/health
```

Expose it with a tunnel. Cloudflare Tunnel shape:

```sh
cloudflared tunnel --url http://127.0.0.1:4188
```

ngrok shape:

```sh
ngrok http 4188
```

Set the Zeabur app environment variables:

```txt
OPENCLAW_BRIDGE_URL=https://your-openclaw-bridge-domain.example
OPENCLAW_BRIDGE_TOKEN=<same secret as OPENCLAW_BRIDGE_TOKEN on the VM>
```

Then redeploy/restart the Zeabur app. Workflow events assigned to
`openclaw.rowlet`, `openclaw.roaringmoon`, `openclaw.charizard`,
`openclaw.mrmime`, `openclaw.mrmine`, or `openclaw.gengar` will call:

```txt
POST $OPENCLAW_BRIDGE_URL/agent-runs
Authorization: Bearer $OPENCLAW_BRIDGE_TOKEN
```

The bridge runs:

```sh
docker exec openclaw openclaw agent --agent <agent> --model <model> --session-key agent:<agent>:harness-<workflowRunId>-<event>-<attempt> --message <A2A envelope> --json
```

Do not expose the bridge without a token. Keep `OPENCLAW_BRIDGE_HOST=127.0.0.1`
when using a tunnel so the bridge is not directly reachable on the LAN.

The future production direction is a real OpenClaw A2A HTTP endpoint instead of
the stdin command adapter. That endpoint should publish an Agent Card at
`/.well-known/agent-card.json`, declare JSON-RPC transport, accept
`message/send`, return `Message` or `Task` results, and later add `tasks/get`
or streaming when long-running jobs need progress updates.

## Zeabur To Local Codex

Zeabur cannot reach `127.0.0.1` on your computer directly. Expose the bridge with a tunnel such as Cloudflare Tunnel or ngrok, then set these Zeabur environment variables:

```txt
CODEX_BRIDGE_URL=https://codex-bridge.jormungandcycle.com
CODEX_BRIDGE_TOKEN=<same-secret-as-local>
```

Run the bridge locally with the matching token:

```powershell
$env:HARNESS_BRIDGE_TOKEN = "<same-secret-as-zeabur>"
$env:CODEX_BRIDGE_REPO_ROOT = "C:\Users\linder\Documents\harness框架"
npm run codex-bridge
```

Keep the bridge bound to `127.0.0.1` and let the tunnel forward to it.

## Verified Zeabur Bridge Parameters

Last checked: 2026-08-07.

Successful dashboard-to-bridge path:

```txt
jormungand.zeabur.app -> https://codex-bridge.jormungandcycle.com -> local Codex bridge -> Codex executor
```

Required Zeabur app environment variables:

```txt
CODEX_BRIDGE_URL=https://codex-bridge.jormungandcycle.com
CODEX_BRIDGE_TOKEN=<same value as local HARNESS_BRIDGE_TOKEN>
SITE_AUTH_USERNAME=<configured in Zeabur>
SITE_AUTH_PASSWORD=<configured in Zeabur>
```

Expected public bridge health:

```txt
protocolVersion=harness-agent-bridge/v0.3
repoRoot=C:\Users\linder\Documents\harness框架
capabilities=cancel, stop, active-run-status, idempotency-key, text-output, runtime-skill-bundles
```

Successful end-to-end workflow smoke test:

```txt
workflowRunId=0e9ef9b3-5df5-4e30-802b-72be1e92b420
planSource=codex-bridge
planStatus=completed
externalRunId=fddef477-e199-4013-bc1b-53de43080050
runtimeSkillResolution=completed
requiredRuntimeBundle=superpowers-full@1.0.0
```

Do not commit `CODEX_BRIDGE_TOKEN`, `HARNESS_BRIDGE_TOKEN`, or
`SITE_AUTH_PASSWORD` values. Store them only in the local shell, Zeabur
environment variables, or the secret manager used by the deployment.
