---
title: Agent Bridge
type: entity
tags: [agent-runtime, codex, openclaw, minimax, lucky, mavis, bridge, tool-use]
status: active
created: 2026-08-11
updated: 2026-08-22
---

# Agent Bridge

## Summary

The agent bridge translates workflow-stage requests into configured Codex
bridge, OpenClaw bridge, OpenClaw A2A, or explicit simulated execution
behavior. Production Codex and OpenClaw HTTP bridges implement
authenticated `harness-agent-bridge/v0.2` or `v0.3` agent runs and
runtime-skill bundle reporting. The v0.3 wire shape is required whenever
runtime skill bundles are present.

The Lucky (`mavis`) executor is served by a dedicated local bridge
(`lucky-mavis-server.mjs`) that talks to MiniMax-M3 through an
OpenAI-compatible chat completions endpoint and exposes a function-calling
tool loop (`read_file`, `write_file`, `edit_file`, `list_dir`,
`run_command`, `search_files`) so a Lucky run can actually read, edit, and
run code on the operator-approved machine. Lucky is no longer dispatched
through `codex-bridge`; see the `## Lucky / mavis runtime` section.

## Responsibility Boundaries

- Owns executor transport selection and request/response normalization.
- Owns bridge protocol compatibility checks.
- Resolves bridge authentication without exposing site-auth credentials to an
  executor host.
- Does not decide workflow stage semantics.

## Runtime Boundaries

- Application adapter: `repos/jormungand/lib/agent-bridge.ts` chooses Codex,
  OpenClaw HTTP, OpenClaw A2A, Lucky bridge, or simulation.
- Codex bridge process: `repos/jormungand/scripts/codex-bridge.mjs` validates
  bearer authentication, protocol v0.3, runtime bundle checksums, and that the
  requested repository matches the configured Git origin before execution. The
  legacy `runMinimaxAgent` path inside this file is a stub that throws; all
  minimax / mavis traffic is now handled by `lucky-mavis-server`.
- OpenClaw bridge service: `repos/jormungand/scripts/openclaw-bridge.mjs`
  validates bearer authentication and requires every runtime bundle descriptor
  to exactly match the VM-local deployed lockfile before download or execution.
  It maintains a per-run journal that powers the live-events SSE surface.
- Lucky bridge service: `repos/jormungand/scripts/lucky-mavis-server.mjs`
  implements the v0.3 bridge protocol and dispatches each run to MiniMax-M3
  with a function-calling tool set. The bridge executes the model's tool
  calls locally (`read_file`, `write_file`, `edit_file`, `list_dir`,
  `run_command`, `search_files`), feeds the tool results back to M3, and
  loops until M3 emits a final assistant message. Active runs are cancelable
  via `POST /workflow-runs/:id/(cancel|stop)`. The 5h Lucky quota is
  tracked in the shared `data/lucky-quota.json` store via
  `lucky-quota-store.mjs`; OpenClaw agents on the same `minimax` account
  share the same quota.
- OpenClaw container: receives the verified skill directory and the task prompt
  from the VM bridge service; it does not receive Jormungand site credentials.

## Lucky / mavis runtime

Lucky's request path is:

1. `lib/agent-bridge.ts: getAgentBridgeUrl("mavis")` returns
   `LUCKY_BRIDGE_URL` (default `http://127.0.0.1:4198`).
2. `invokeConfiguredAgent` POSTs the bridge protocol payload to
   `${LUCKY_BRIDGE_URL}/agent-runs`.
3. The server (PID managed by `scripts/start-lucky-mavis-server.ps1`)
   builds the user prompt, sends it to `LUCKY_BACKEND_URL`
   (`https://api.minimax.io/v1/chat/completions` by default, model
   `MiniMax-M3`) with the tool schema, and processes the
   `tool_calls` M3 returns.
4. Tools run with `JORMUNGAND_AGENT_PERMISSION_MODE=full` (the default);
   there is no filesystem sandbox. The model is trusted the same way the
   Codex executor is trusted.
5. A 5h sliding-window quota (`LUCKY_QUOTA_WINDOW_SECONDS`, default
   `18000`) is shared between Lucky and the five OpenClaw agents on the
   same `minimax` account. Read the live usage from
   `GET /agent-quota?executor=mavis`.

A Next.js forwarder at `app/api/lucky/[...path]/route.ts` (with the bare
URL handled by `app/api/lucky/route.ts`) proxies client-side requests
to the same server. The dashboard's server-side `invokeConfiguredAgent`
hits the bridge URL directly, so the Next.js route is currently
client-side only and exists for any future "chat with Lucky" panel.

## Deployment And Trust

The OpenClaw deployment script uses pinned SSH host keys, synchronizes the
bridge implementation and `.harness/skill.lock.json`, and configures the user
service on loopback port 4178. Cloudflare provides the public bridge ingress.
Codex has a separate repository-origin guard and bridge-local bundle
verification; it does not use the VM-local OpenClaw allowlist.

The Lucky bridge binds to loopback by default (`LUCKY_BRIDGE_HOST=127.0.0.1`,
port 4198) and requires `LUCKY_BRIDGE_TOKEN` (or `HARNESS_BRIDGE_TOKEN` /
`CODEX_BRIDGE_TOKEN`) for non-loopback binds. Run it via
`scripts/start-lucky-mavis-server.ps1` — that script defaults
`LUCKY_BACKEND_URL` to `https://api.minimax.io/v1` and the model to
`MiniMax-M3`, falls back to existing `MINIMAX_*` env vars for
backward compatibility, and points the quota store at
`<repo>/data/lucky-quota.json` so the Codex bridge and OpenClaw
bridge share the same 5h window.

Bridge health is authenticated. The application exposes public liveness only
through `/health`; `/api/agent-health` remains behind site authentication. The
dashboard's visible-bridges filter still hides the `minimax-bridge` card;
the agent-health probe now points at `LUCKY_BRIDGE_URL` so the health check
reflects the new server.

## Source

- Primary path: `repos/jormungand/lib/agent-bridge.ts`
- A2A protocol helper: `repos/jormungand/lib/a2a-protocol.ts`
- Agent profiles: `repos/jormungand/lib/agents.ts`
- Agent permission mode: `repos/jormungand/lib/agent-permissions.ts` and
  `repos/jormungand/scripts/agent-permissions.mjs`
- Codex bridge: `repos/jormungand/scripts/codex-bridge.mjs`
- OpenClaw bridge: `repos/jormungand/scripts/openclaw-bridge.mjs`
- Lucky bridge: `repos/jormungand/scripts/lucky-mavis-server.mjs`
- Lucky quota store: `repos/jormungand/scripts/lucky-quota-store.mjs`
- Lucky bridge daemon: `repos/jormungand/scripts/start-lucky-mavis-server.ps1`
- Lucky bridge Next.js proxy: `repos/jormungand/app/api/lucky/[...path]/route.ts`
  (with the bare URL at `repos/jormungand/app/api/lucky/route.ts`)
- Legacy minimax bridge (kept as an A2A-fallback prototype, not used by
  the workflow engine): `repos/jormungand/scripts/minimax-bridge.mjs`
- OpenClaw deployment: `repos/jormungand/scripts/deploy-openclaw-bridge.ps1`
- Runtime-skill policy: `repos/jormungand/.harness/skill.lock.json`
- Spec: [[spec/agent-bridge/SPEC]]
- Repository layer: [[repos/README]]

## Adjacent Subsystems

- **Agent permission mode** (`JORMUNGAND_AGENT_PERMISSION_MODE`) decides
  whether the Codex bridge passes
  `--dangerously-bypass-approvals-and-sandbox` (`full`, the default) or
  keeps `--sandbox workspace-write` and lets the operator approve
  per-request (`restricted`). The same flag also affects the workflow
  approval gates, the manager `request_approval` action, and Lucky's
  tool loop (which runs unrestricted under `full`); see [[spec/SPEC]]
  for the full contract.
- **OpenClaw live-event relay** (`createOpenClawLiveRelay` inside
  `lib/agent-bridge.ts:384`) polls
  `GET /agent-runs/by-idempotency/:key/events?after=<cursor>` on the
  OpenClaw bridge in parallel with the main HTTP `await`, and publishes
  frames into the in-process `agentLiveBus`. The dashboard's
  `/api/conversation/live` SSE route replays a bounded recent snapshot
  and then streams the live tail. The Lucky bridge exposes the same
  `/agent-runs/by-idempotency/:key/events` shape for parity.
- **A2A v0.3 dispatch** uses the same `invokeConfiguredAgent`
  chokepoint, but routes OpenClaw A2A and minimax A2A to `spawn`
  processes that speak the public v0.3 JSON-RPC envelope
  (`OPENCLAW_A2A_COMMAND`, `MINIMAX_A2A_COMMAND`). The full A2A
  contract is in [[spec/SPEC]].
- **Superpowers skill catalog** supplies the runtime skill bundles
  installed before a run; the resolver lives at
  `repos/jormungand/lib/runtime-skills.ts` and the catalog fetcher at
  `repos/jormungand/lib/superpowers-catalog.ts`. Dedicated entity and
  concept pages for these are deferred to a follow-up cycle; see
  [[raw/2026-08-21-wiki-spec-refresh]].

## Procedural Position

[[wiki/entities/workflow-engine]] invokes the agent bridge when an event skill must produce an artifact through an external or simulated executor.

## References

- [[raw/2026-08-11-graphify-code-only-run]]
- [[raw/2026-08-13-secure-bridge-deployment-verification]]
- [[raw/2026-08-13-graphify-deep-minimax-run]]
- [[raw/2026-08-21-wiki-spec-refresh]]
- [[wiki/concepts/tech-debt-synchronous-bridge-transport]]
- [[wiki/concepts/architecture-risk-register-2026-08-22]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
