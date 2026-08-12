---
title: Jormungand Dynamic View
type: c4
tags: [architecture, c4, dynamic]
status: active
created: 2026-08-11
updated: 2026-08-11
---

# Jormungand Dynamic View

## View

Canonical Structurizr view key: `dynamicStartWorkflowRun`

## Summary

The dynamic view shows the primary runtime path: an operator submits a workflow
run, the dashboard posts to the API, the workflow engine creates and advances
state, runtime skills are resolved, the configured agent bridge is invoked, and
artifacts/gates/events are persisted.

## Generated Diagrams

- `wiki/c4/diagrams/dynamic-start-workflow-run.mmd`
- `wiki/c4/diagrams/dynamic-start-workflow-run.svg`

## Evidence

- `app/api/workflow-runs/route.ts`
- `lib/workflow.ts`
- `lib/agent-bridge.ts`
- `lib/runtime-skills.ts`
- `lib/store.ts`
