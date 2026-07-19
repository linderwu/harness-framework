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

OpenClaw profiles use ids such as `openclaw.rowlet`, `openclaw.roaringmoon`, and `openclaw.charizard`. When one is assigned, the Next.js API calls `OPENCLAW_BRIDGE_URL` and includes `mainAgent` in the payload.

## OpenClaw A2A Command

OpenClaw can also run through the accepted ClawCodex A2A session protocol. Set
`OPENCLAW_A2A_COMMAND` to a local command that reads a JSON envelope from stdin
and writes either OpenClaw `--json` output or plain text to stdout.

The app passes these environment variables to the command:

```txt
OPENCLAW_A2A_AGENT=rowlet|roaringmoon|charizard
OPENCLAW_A2A_MODEL=minimax/MiniMax-M2.7
OPENCLAW_A2A_SESSION_KEY=agent:<agent>:a2a-codex
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

## Zeabur To Local Codex

Zeabur cannot reach `127.0.0.1` on your computer directly. Expose the bridge with a tunnel such as Cloudflare Tunnel or ngrok, then set these Zeabur environment variables:

```txt
CODEX_BRIDGE_URL=https://your-tunnel-url
CODEX_BRIDGE_TOKEN=<same-secret-as-local>
```

Run the bridge locally with the matching token:

```powershell
$env:HARNESS_BRIDGE_TOKEN = "<same-secret-as-zeabur>"
$env:CODEX_BRIDGE_REPO_ROOT = "C:\Users\linder\Documents\harness框架"
npm run codex-bridge
```

Keep the bridge bound to `127.0.0.1` and let the tunnel forward to it.
