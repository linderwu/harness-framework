---
title: Agent Bridge
type: entity
tags: [agent-runtime, codex, openclaw, minimax, bridge]
status: active
created: 2026-08-11
updated: 2026-08-21
---

# Agent Bridge

## Summary

The agent bridge translates workflow-stage requests into configured Codex
bridge, OpenClaw bridge, OpenClaw A2A, minimax bridge, or explicit
simulated execution behavior. Production Codex, OpenClaw, and minimax
HTTP bridges implement authenticated `harness-agent-bridge/v0.2` or
`v0.3` agent runs and runtime-skill bundle reporting. The v0.3 wire
shape is required whenever runtime skill bundles are present.

## Responsibility Boundaries

- Owns executor transport selection and request/response normalization.
- Owns bridge protocol compatibility checks.
- Resolves bridge authentication without exposing site-auth credentials to an
  executor host.
- Does not decide workflow stage semantics.

## Runtime Boundaries

- Application adapter: `repos/jormungand/lib/agent-bridge.ts` chooses Codex,
  OpenClaw HTTP, OpenClaw A2A, minimax HTTP, minimax A2A, or simulation.
- Codex bridge process: `repos/jormungand/scripts/codex-bridge.mjs` validates
  bearer authentication, protocol v0.3, runtime bundle checksums, and that the
  requested repository matches the configured Git origin before execution. It
  also runs a `minimax` executor path against an OpenAI-compatible backend
  URL or a local command.
- OpenClaw bridge service: `repos/jormungand/scripts/openclaw-bridge.mjs`
  validates bearer authentication and requires every runtime bundle descriptor
  to exactly match the VM-local deployed lockfile before download or execution.
  It maintains a per-run journal that powers the live-events SSE surface.
- minimax bridge service: `repos/jormungand/scripts/minimax-bridge.mjs` is a
  thin OpenAI-compatible proxy. It POSTs to `MINIMAX_BACKEND_URL` when set,
  otherwise spawns `MINIMAX_BACKEND_COMMAND` with the prompt on stdin.
- OpenClaw container: receives the verified skill directory and the task prompt
  from the VM bridge service; it does not receive Jormungand site credentials.

## Deployment And Trust

The OpenClaw deployment script uses pinned SSH host keys, synchronizes the
bridge implementation and `.harness/skill.lock.json`, and configures the user
service on loopback port 4178. Cloudflare provides the public bridge ingress.
Codex has a separate repository-origin guard and bridge-local bundle
verification; it does not use the VM-local OpenClaw allowlist.

Bridge health is authenticated. The application exposes public liveness only
through `/health`; `/api/agent-health` remains behind site authentication.

## Source

- Primary path: `repos/jormungand/lib/agent-bridge.ts`
- A2A protocol helper: `repos/jormungand/lib/a2a-protocol.ts`
- Agent profiles: `repos/jormungand/lib/agents.ts`
- Agent permission mode: `repos/jormungand/lib/agent-permissions.ts` and
  `repos/jormungand/scripts/agent-permissions.mjs`
- Codex bridge: `repos/jormungand/scripts/codex-bridge.mjs`
- OpenClaw bridge: `repos/jormungand/scripts/openclaw-bridge.mjs`
- minimax bridge: `repos/jormungand/scripts/minimax-bridge.mjs`
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
  approval gates and the manager `request_approval` action; see
  [[spec/SPEC]] for the full contract.
- **OpenClaw live-event relay** (`createOpenClawLiveRelay` inside
  `lib/agent-bridge.ts:384`) polls
  `GET /agent-runs/by-idempotency/:key/events?after=<cursor>` on the
  OpenClaw bridge in parallel with the main HTTP `await`, and publishes
  frames into the in-process `agentLiveBus`. The dashboard's
  `/api/conversation/live` SSE route replays a bounded recent snapshot
  and then streams the live tail.
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
- `graphify/jormungand-root/GRAPH_REPORT.md`
