---
title: Jormungand Deployment View
type: c4
tags: [architecture, c4, deployment]
status: active
created: 2026-08-11
updated: 2026-08-13
---

# Jormungand Deployment View

## View

Canonical Structurizr view keys:

- `deploymentLocal`
- `deploymentProduction`

## Summary

The local view describes a browser, local Next.js process, JSON state, and
optional configured bridges.

The production view describes the verified deployment boundary:

- An operator reaches Zeabur over HTTPS.
- `/health` is public liveness; the UI, API, and `/api/agent-health` require site
  authentication by default.
- Zeabur invokes authenticated Codex and OpenClaw Bridge endpoints using
  protocol v0.3.
- The Codex bridge executes only in its configured repository workspace after
  origin validation.
- Cloudflare tunnels OpenClaw traffic to the VM user service on loopback port
  4178, which invokes the OpenClaw Docker container.
- A deployment workstation reaches the VM with a pinned SSH host key and
  synchronizes both `openclaw-bridge.mjs` and `.harness/skill.lock.json`.
- Both bridges verify runtime bundle checksums; OpenClaw additionally enforces
  the deployed VM-local exact allowlist before installation.

## Generated Diagrams

- `wiki/c4/diagrams/deployment-local.mmd`
- `wiki/c4/diagrams/deployment-local.svg`
- `wiki/c4/diagrams/deployment-production.mmd`
- `wiki/c4/diagrams/deployment-production.svg`

## Evidence And Inference

- Local: Next.js app structure, local JSON store, and configured integration
  variables.
- Production: [[raw/2026-08-13-secure-bridge-deployment-verification]].
- Diagram generation: [[raw/2026-08-13-c4-production-diagram-generation]].
- Accepted durability limitation:
  [[wiki/concepts/tech-debt-json-state-persistence]].
- Accepted transport limitation:
  [[wiki/concepts/tech-debt-synchronous-bridge-transport]].
