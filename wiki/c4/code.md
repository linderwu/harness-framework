---
title: Jormungand Code-Level Reference View
type: c4
tags: [architecture, c4, code]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Jormungand Code-Level Reference View

## View

Canonical view key: `codeKeyAbstractions`

## Summary

C4 level 4 is intentionally narrow here. The useful cognitive-debt reducer is
not a full class diagram of the entire application, but a reference map of the
central workflow abstractions that explain how runs, event skills, gates, agent
invocation, artifact results, and runtime skill resolution fit together.

## Generated Diagrams

- `wiki/c4/diagrams/code-key-abstractions.mmd`
- `wiki/c4/diagrams/code-key-abstractions.svg`

## Evidence

- `repos/jormungand/lib/types.ts`
- `repos/jormungand/lib/workflow.ts`
- `repos/jormungand/lib/agent-bridge.ts`
- `repos/jormungand/lib/runtime-skills.ts`
- `graphify/jormungand-root/GRAPH_REPORT.md`
