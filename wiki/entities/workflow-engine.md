---
title: Workflow Engine
type: entity
tags: [workflow, domain, runtime]
status: active
created: 2026-08-11
updated: 2026-08-13
---

# Workflow Engine

## Summary

The workflow engine creates workflow runs, advances stage state, records artifacts, opens approval gates, and routes agent tasks through configured executors.

## Responsibility Boundaries

- Owns workflow state transitions and artifact/gate creation.
- Does not own persistent storage implementation.
- Does not own external agent transport details.

## Project-Type Semantics

`agent_task` is a distinct one-stage execution path. Research, Development,
Testing, Documentation, Diagnosis, and Decision currently provide different
project templates and phase labels but share the same default workflow event
skill chain. Template creation was verified independently from real bridge
workflow execution; see
[[raw/2026-08-13-secure-bridge-deployment-verification]].

## Source

- Primary path: `repos/jormungand/lib/workflow.ts`
- Types: `repos/jormungand/lib/types.ts`
- Spec: [[spec/workflow/SPEC]]
- Repository layer: [[repos/README]]

## Procedural Position

API routes call workflow functions. The workflow engine calls [[wiki/entities/agent-bridge]] for agent execution and [[wiki/entities/workspace-store]] for persistence through route-level orchestration.

## References

- [[raw/2026-08-11-graphify-code-only-run]]
- [[raw/2026-08-13-graphify-deep-minimax-run]]
- [[wiki/concepts/tech-debt-synchronous-bridge-transport]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
