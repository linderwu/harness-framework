---
title: Jormungand Dynamic View
type: c4
tags: [architecture, c4, dynamic]
status: active
created: 2026-08-11
updated: 2026-08-13
---

# Jormungand Dynamic View

## View

Canonical Structurizr view key: `dynamicStartWorkflowRun`

## Summary

The dynamic view shows the primary runtime path: an operator submits a workflow
run, the dashboard posts to the API, the workflow engine creates and advances
state, runtime skills are resolved against the registry and lockfile, the
configured authenticated Codex or OpenClaw bridge is invoked with protocol
v0.3, and artifacts/gates/events are persisted.

## Generated Diagrams

- `wiki/c4/diagrams/dynamic-start-workflow-run.mmd`
- `wiki/c4/diagrams/dynamic-start-workflow-run.svg`

## Evidence

- `repos/jormungand/app/api/workflow-runs/route.ts`
- `repos/jormungand/lib/workflow.ts`
- `repos/jormungand/lib/agent-bridge.ts`
- `repos/jormungand/lib/runtime-skills.ts`
- `repos/jormungand/lib/store.ts`
- [[raw/2026-08-13-secure-bridge-deployment-verification]]
