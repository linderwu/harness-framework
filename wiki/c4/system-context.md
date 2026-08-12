---
title: Jormungand System Context
type: c4
tags: [architecture, c4, system-context]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Jormungand System Context

## View

Canonical Structurizr view key: `systemContext`

## Summary

Jormungand is a local harness dashboard for project workflow orchestration. An operator uses the dashboard to create projects, start workflow runs, review generated artifacts, and decide approval gates.

## External Systems

- Codex Bridge: local Codex execution bridge.
- OpenClaw Runtime: optional OpenClaw bridge or A2A executor.
- GitHub: repository source and intake-time repository readiness target.

## Generated Diagrams

- `wiki/c4/diagrams/system-context.mmd`
- `wiki/c4/diagrams/system-context.svg`

## Evidence

- [[raw/2026-08-11-user-request-ouroboros-application]]
- [[raw/2026-08-11-graphify-code-only-run]]
- `wiki/c4/workspace.dsl`
