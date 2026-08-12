---
title: Jormungand Deployment View
type: c4
tags: [architecture, c4, deployment]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Jormungand Deployment View

## View

Canonical Structurizr view key: `deploymentLocal`

## Summary

The current deployment view describes the local development/runtime topology:
the browser talks to a local Next.js process, the process reads and writes local
JSON state, and optional Codex/OpenClaw/GitHub integrations are reached through
configured URLs or commands.

## Generated Diagrams

- `wiki/c4/diagrams/deployment-local.mmd`
- `wiki/c4/diagrams/deployment-local.svg`

## Evidence And Inference

- Evidence-backed: Next.js app structure and local JSON store usage.
- Partly inferred: exact process boundaries for optional Codex/OpenClaw bridge
  runtimes, because they are controlled by environment variables.
