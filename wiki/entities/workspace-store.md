---
title: Workspace Store
type: entity
tags: [persistence, workspace, json-state]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Workspace Store

## Summary

The workspace store persists projects, workflow runs, artifacts, approval gates, warnings, and normalized workspace state.

## Responsibility Boundaries

- Owns JSON-backed workspace persistence and normalization.
- Does not own user interface behavior.
- Does not execute workflow stages.

## Source

- Store implementation: `repos/jormungand/lib/store.ts`
- Workspace normalization: `repos/jormungand/lib/workspace.ts`
- Spec: [[spec/workspace/SPEC]]
- Repository layer: [[repos/README]]

## Procedural Position

API routes use the store to read/write workflow and project records around [[wiki/entities/workflow-engine]] operations.

## References

- [[raw/2026-08-11-graphify-code-only-run]]
- `graphify/jormungand-root/GRAPH_REPORT.md`
