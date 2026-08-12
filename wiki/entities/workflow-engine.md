---
title: Workflow Engine
type: entity
tags: [workflow, domain, runtime]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Workflow Engine

## Summary

The workflow engine creates workflow runs, advances stage state, records artifacts, opens approval gates, and routes agent tasks through configured executors.

## Responsibility Boundaries

- Owns workflow state transitions and artifact/gate creation.
- Does not own persistent storage implementation.
- Does not own external agent transport details.

## Source

- Primary path: `repos/jormungand/lib/workflow.ts`
- Types: `repos/jormungand/lib/types.ts`
- Spec: [[spec/workflow/SPEC]]
- Repository layer: [[repos/README]]

## Procedural Position

API routes call workflow functions. The workflow engine calls [[wiki/entities/agent-bridge]] for agent execution and [[wiki/entities/workspace-store]] for persistence through route-level orchestration.

## References

- [[raw/2026-08-11-graphify-code-only-run]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
