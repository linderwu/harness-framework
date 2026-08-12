---
title: Agent Bridge
type: entity
tags: [agent-runtime, codex, openclaw, bridge]
status: active
created: 2026-08-11
updated: 2026-08-13
---

# Agent Bridge

## Summary

The agent bridge translates workflow-stage requests into configured Codex
bridge, OpenClaw bridge, OpenClaw A2A, or explicit simulated execution
behavior. Production Codex and OpenClaw HTTP bridges implement authenticated
`harness-agent-bridge/v0.3` agent runs and runtime-skill bundle reporting.

## Responsibility Boundaries

- Owns executor transport selection and request/response normalization.
- Owns bridge protocol compatibility checks.
- Resolves bridge authentication without exposing site-auth credentials to an
  executor host.
- Does not decide workflow stage semantics.

## Runtime Boundaries

- Application adapter: `repos/jormungand/lib/agent-bridge.ts` chooses Codex,
  OpenClaw HTTP, OpenClaw A2A, or simulation.
- Codex bridge process: `repos/jormungand/scripts/codex-bridge.mjs` validates
  bearer authentication, protocol v0.3, runtime bundle checksums, and that the
  requested repository matches the configured Git origin before execution.
- OpenClaw bridge service: `repos/jormungand/scripts/openclaw-bridge.mjs`
  validates bearer authentication and requires every runtime bundle descriptor
  to exactly match the VM-local deployed lockfile before download or execution.
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
- Codex bridge: `repos/jormungand/scripts/codex-bridge.mjs`
- OpenClaw bridge: `repos/jormungand/scripts/openclaw-bridge.mjs`
- OpenClaw deployment: `repos/jormungand/scripts/deploy-openclaw-bridge.ps1`
- Runtime-skill policy: `repos/jormungand/.harness/skill.lock.json`
- Spec: [[spec/agent-bridge/SPEC]]
- Repository layer: [[repos/README]]

## Procedural Position

[[wiki/entities/workflow-engine]] invokes the agent bridge when an event skill must produce an artifact through an external or simulated executor.

## References

- [[raw/2026-08-11-graphify-code-only-run]]
- [[raw/2026-08-13-secure-bridge-deployment-verification]]
- [[raw/2026-08-13-graphify-deep-minimax-run]]
- [[wiki/concepts/tech-debt-synchronous-bridge-transport]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
