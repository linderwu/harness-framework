# Local Codex Bridge

The dashboard records `codex` and concrete OpenClaw profiles as workflow executors. To make `codex` execute on this machine, run the local bridge and point the app at it.

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

Without `CODEX_BRIDGE_URL`, Codex fails closed by default instead of silently
creating simulated artifacts. Set `HARNESS_ALLOW_SIMULATED_AGENTS=1`
only when you intentionally want local demo artifacts instead of a real agent
run.

## Ouroboros-Aware Repositories

Jormungandr-created GitHub repositories are seeded with an `AGENTS.md` contract
that asks future agents to run an Ouroboros preflight before substantial work.
The contract uses a size gate:

- `<5` important source files: skip full Ouroboros and read the code directly.
- `5-20` files: use lightweight Ouroboros, with `raw/`, focused `spec/`, and
  graphify only for hub modules.
- `>20` files: use full `raw/`, `graphify/`, `wiki/`, and `spec/`.

The same contract is also injected into local Codex bridge prompts so workflow
agents see the rule even before the generated repo has been cloned locally.
The contract keeps `raw/` append-only, routes durable design rationale to
reviewed `wiki/` pages, routes code-derived interfaces to `spec/`, and forbids
parallel evidence layers such as `wiki/raw/`.

OpenClaw profiles use ids such as `openclaw.rowlet`, `openclaw.roaringmoon`, and `openclaw.charizard`. When one is assigned, the Next.js API calls `OPENCLAW_BRIDGE_URL` and includes `mainAgent` in the payload.

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
OPENCLAW_A2A_AGENT=rowlet|roaringmoon|charizard
OPENCLAW_A2A_MODEL=minimax/MiniMax-M2.7
OPENCLAW_A2A_SESSION_KEY=agent:<agent>:a2a-codex
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
